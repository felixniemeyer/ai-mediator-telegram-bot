import fs from "fs";
import { OpenAIApi, Configuration, ChatCompletionRequestMessage } from 'openai';

const DONT_CALL_CHAT_GPT = process.env.DONT_CALL_CHAT_GPT || false
const STORAGE_PATH = process.env.STORAGE_PATH || 'mediations'

console.log('DON\'T CALL CHAT GPT:', DONT_CALL_CHAT_GPT)

const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

function randomKey() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

export interface MediationId {
  chatId: number
  id: string
}

interface Participant {
  userId: number, 
  name: string,
}

interface Mediation {
  id: MediationId, 
  participants: Participant[]
  title: string
  state: 'open' | 'closed' | 'finished'
}

function mediationFile(mediationId: MediationId) {
  return mediationDir(mediationId) + '/meta.json';
}

function mediationDir (mediationId: MediationId) {
  return `./${STORAGE_PATH}/g${mediationId.chatId.toString()}/${mediationId.id}`;
}

function participantDir (mediationId: MediationId, userId: number) {
  return mediationDir(mediationId) + '/' + userId;
}

function perspectiveFile(mediationId: MediationId, userId: number) {
  return participantDir(mediationId, userId) + '/perspective.txt';
}

function answerFile(mediationId: MediationId, userId: number) {
  return participantDir(mediationId, userId) + '/answer.txt';
}

export function joinMediationId(mediationId: MediationId) {
  return mediationId.chatId.toString() + '%' + mediationId.id
}

export async function createMediation(title: string, chatId: number) {
  const mediation = {
    title, 
    id: {
      chatId, 
      id: randomKey(),
    }, 
    participants: [], 
    state: 'open', 
  } as Mediation

  await fs.promises.mkdir(mediationDir(mediation.id), {recursive: true})
  await fs.promises.writeFile(
    mediationFile(mediation.id), 
    JSON.stringify(mediation)
  );

  return mediation
}

const mediationFileLocks = new Set<string>()
const mediationFileQueues = {} as {[jointId: string]: ((mediation: Mediation) => void)[]}
async function loadMediation(
  mediationId: MediationId, 
  callback: (mediation: Mediation) => Promise<void>
) {
  const jointId = joinMediationId(mediationId)
  let mediation 
  if(mediationFileLocks.has(jointId)) {
    mediationFileQueues[jointId] = mediationFileQueues[jointId] || []
    mediation = await new Promise((resolve) => {
      mediationFileQueues[jointId].push(resolve)
    })
  } else {
    const file = mediationFile(mediationId)
    console.log(file) 
    const data = await fs.promises.readFile(file, 'utf8')
    mediation = JSON.parse(data.toString())
    mediationFileLocks.add(jointId)
  }
  try{
    await callback(mediation)
  } catch {
  } finally {
    const queue = mediationFileQueues[jointId]
    if(queue && queue.length > 1) {
      const next = queue.shift()!
      next(mediation)
    } else {
      saveMediation(mediation) 
      mediationFileLocks.delete(jointId)
    }
  }
}

async function saveMediation(mediation: Mediation) {
  await fs.promises.writeFile(mediationFile(mediation.id), JSON.stringify(mediation))
}

interface ParticipationFeedback {
  alreadyJoined: boolean, 
  mediationTitle: string, 
  participantCount: number,
}
export function participate(userId: number, name: string, mediationId: MediationId) {
  return new Promise<ParticipationFeedback>(async (resolve, _reject) => {
    loadMediation(mediationId, async (mediation) => {
      if(!mediation) {
        throw new Error('Mediation not found.')
      } else if (mediation.state !== 'open') {
        throw new Error('Mediation is already closed.')
      } else {
        const alreadyJoined = mediation.participants.find(p => p.userId === userId) !== undefined
        if(!alreadyJoined) {
          mediation.participants.push({
            userId, 
            name
          });
          await fs.promises.mkdir(participantDir(mediationId, userId), {recursive: true})
        }
        resolve({
          alreadyJoined,
          mediationTitle: mediation.title,
          participantCount: mediation.participants.length,
        })
      }
    })
  })
}

export function closeMediation(mediationId: MediationId) {
  return new Promise<string>(async (resolve, reject) => {
    loadMediation(mediationId, async (mediation) => {
      if(mediation.participants.length > 0) {
        mediation.state = 'closed'
        resolve(mediation.title)
      } else {
        reject('Not enough participants.')
      }
    }) 
  })
}

interface checkAndConsultResponse {
  finished: boolean,
  receivedPerspectivesCount?: number,
  participantCount?: number,
}
export function checkWhetherMediationIsReadyAndConsultChatGPT(
  mediationId: MediationId, 
  onAnswerReady: (userId: number, answer: string) => void
) {
  return new Promise<checkAndConsultResponse>(async (resolve, _reject) => {
    loadMediation(mediationId, async (mediation) => {
      console.log('checkWhetherMediationIsReadyAndConsultChatGPT', mediation)
      interface Loaded {
        userId: number, 
        perspective?: string,
      }
      Promise.all<Loaded | null>(
        mediation.participants.map(
          participant => new Promise((resolve, _reject) => {
            fs.readFile(perspectiveFile(mediation.id, participant.userId), (err, data) => {
              if (err) {
                // perspective not there yet 
                resolve({
                  userId: participant.userId
                });
              } else {
                resolve({
                  userId: participant.userId,
                  perspective: data.toString()
                })
              }
            })
          })
        )
      )
      .then((results) => {
        const perspectives = {} as {[key: number]: string}
        const participantCount = mediation.participants.length
        let receivedPerspectivesCount = 0
        results.forEach((result) => {
          if(result?.perspective !== undefined) {
            receivedPerspectivesCount++
            perspectives[result.userId] = result.perspective
          }
        }) 
        if(participantCount == receivedPerspectivesCount) {
          consultChatGPT(mediation, perspectives, onAnswerReady)
          resolve({
            finished: true,
          })
          mediation.state = 'finished'
        } else {
          resolve({
            finished: false,
            receivedPerspectivesCount,
            participantCount,
          })
        }
      })
    })
  })
}

function consultChatGPT(
  mediation: Mediation, 
  perspectives: {[userId: string]: string}, 
  onAnswerReady: (userId: number, answer: string) => void
) {
  // load all perspectives from fs
  const participants = mediation.participants
  participants.forEach((participant, i: number) => {
    const name = participant.name;
    const userId = participant.userId;
    const perspective = perspectives[userId]

    const nameList = participants.map((participant: any) => participant.name);
    const nameString = nameList.slice(0,-1).join(', ') + ' and ' + nameList.slice(-1)[0];
    let frame = `Hey ChatGPT, there are ${participants.length} people who have a conflict: ${nameString}. Everyone has his own perspective on the conflict. Please read their versions of the truth and give ${name} some suggestions on how to deal with the situation in a constructive way.`

    let othersPerspectivesString = `Here are the other peoples' perspectives:\n\n`

    let messages = [{"role": "system", "content": frame}] as ChatCompletionRequestMessage[]
    for(let j = 1; j < participants.length; j++) {
      const index = (i + j) % participants.length;
      const otherParticipant = participants[index];
      const otherPerspective = perspectives[otherParticipant.userId];
      othersPerspectivesString += `Person ${j}, ${otherParticipant.name}:\n${otherPerspective}`
    }

    messages.push({"role": "system", "content": othersPerspectivesString})

    messages.push({"role": "system", "content": `Here is the user's (${name}) perspective:`})

    messages.push({
      "role": 'user',
      "content": perspective
    })

    messages.push({"role": "system", "content": `Please give the user (${name}) some suggestions on how to deal with the situation in a constructive way or what to reflect about. Answer in the same language as the user (${name}) used in his message. If you think something is amiss or there is a misunderstanding, suggest 'starting a new mediation in the group chat'.`})

    const callParams = {
      model: "gpt-3.5-turbo-0301",
      messages: messages,
    }

    console.log('chatGPT request:', callParams)
    if(!DONT_CALL_CHAT_GPT) {
      openai.createChatCompletion(callParams).then((response) => {
        console.log(response.data);
        console.log(JSON.stringify(response.data))
        try {
          const answer = response.data.choices[0].message?.content;
          if(!answer) {
            throw(new Error('no answer or unexpected answer format'))
          } else {
            onAnswerReady(userId, answer)
            fs.writeFile(answerFile(mediation.id, userId), answer, (err) => {
              if (err) {
                console.log(err);
              }
            })
          }
        } catch (e) {
          console.error('something went wrong when parsing the response from openai', e);
        }
      }).catch((error) => {
        console.log('error calling openai: ', error);
      })
    }
  });
}

interface StorePerspectiveResponse {
  alreadyStored: boolean,
  mediationTitle: string,
  mediationClosed: boolean,
}

export function storePerspective(mediationId: MediationId, userId: number, perspective: string) {
  return new Promise<StorePerspectiveResponse>(async (resolve, _reject) => {
    loadMediation(mediationId, async (mediation: Mediation) => {
      if(mediation) {

        // check if perspective file exists
        let alreadyStored = false
        try {
          await fs.promises.access(perspectiveFile(mediationId, userId))
          alreadyStored = true
        } catch (err) {
          // file does not exist
        }

        await fs.promises.writeFile(
          perspectiveFile(mediationId, userId), 
          perspective
        );

        if(mediation.state === 'closed') {
        } 

        resolve({
          alreadyStored, 
          mediationTitle: mediation.title,
          mediationClosed: mediation.state === 'closed',
        }) 
      }
    })
  })
}


import dotenv from 'dotenv';
dotenv.config();

import * as lib from './lib';

import { Bot, Context, InlineKeyboard } from "grammy";
import { User } from 'grammy/out/types.node';

const bot = new Bot(process.env.BOT_TOKEN!)

const helpMessage = `I am a bot based on ChatGPT that helps people to find solutions in interpersonal conflicts. You can initiate a new mediation by sending\n/mediate <i>title</i>\n in any group chat.\n\nAnyone can then join the mediation and participate by explaining to me in a private chat, what is their perspective on the situation. After reading all perspective I will try to give helpful ideas how to handle the situation to each participant. `

const startErrorMessage = `Don't /start me manually in private chat. Follow a link by clicking on the participate button in a group chat instead. Create such a link in a group with the\n/mediate <i>title</i>\ncommand.`

enum Actions {
  closeMediation = 'C'
}

const previousCloseButtonMessages = {} as {[jointId: string]: any}
const usersCurrentMediations = {} as {[userId: number]: lib.MediationId}

function makeMention(user: User) {
  let mention = user.first_name || user.id.toString()
  if(user.username) {
    mention = `@${user.username}`
  }
  return mention
}

bot.command("help", ctx => ctx.reply(helpMessage))

bot.command('start', async (ctx) => {
  const spaceSplit = ctx.message!.text.split(" ")
  if(spaceSplit.length < 2) {
    ctx.reply(startErrorMessage)
    console.warn('somebody tried to call start with params', spaceSplit)
    return 
  }
  const params = Buffer.from(spaceSplit[1], 'base64').toString('utf8').split('+')
  const chatId = parseInt(params[0]); 
  const id = params[1];
  if(!chatId || !id) {
    ctx.reply(startErrorMessage)
    console.warn('somebody tried to call start with params', spaceSplit)
    return 
  } else {
    const userId = ctx.from!.id;
    const userName = (
      (ctx.from!.first_name) || '' + (ctx.from!.last_name || '')
    ) || ctx.from!.username || ctx.from!.id.toString()

    const mediationId = {chatId, id}
    lib.participate(userId, userName, mediationId).then(status => {
      usersCurrentMediations[userId] = mediationId

      const joinMessage = `${makeMention(ctx.from!)} has joined the mediation "${status.mediationTitle}".`
      ctx.reply(status.alreadyJoined ? 
        `Welcome back to the mediation "${status.mediationTitle}". What is your perspective on the situation? ` : 
        `Thank you for participating in the mediation "${status.mediationTitle}". ` 
          + '\nPlease tell me your perspective on the situation.'
      )

      if(status.participantCount > 1) {
        const closeMessage = "\nClick on close if you don't expect any more participants."
        const keyboard = new InlineKeyboard()
          .text("close", Actions.closeMediation + ' ' + chatId + ' ' + id)

        ctx.api.sendMessage(
          chatId, joinMessage + closeMessage, 
          { 
            reply_markup: keyboard
          }
        )
        .then(msg => {
          const jointId = lib.joinMediationId(mediationId)
          maybeRemoveCloseButtonFromPreviousMessage(ctx.api, jointId)
          previousCloseButtonMessages[jointId] = msg
        })
      } else {
        ctx.api.sendMessage(chatId, joinMessage + "\nWe need at least one other participant.") 
      }
    })
  } 
})

function maybeRemoveCloseButtonFromPreviousMessage(api: any, jointId: string) {
  const prevMsg = previousCloseButtonMessages[jointId]
  if(prevMsg) {
    const emptyKeyboardMarkup = new InlineKeyboard();
    const cut = prevMsg.text.indexOf('". Since') 
    const overrideText = prevMsg.text.substring(0, cut + 2)
    if(cut > 0) {
      api.editMessageText(
        prevMsg.chatId,
        prevMsg.message_id,
        overrideText, 
        {
          reply_markup: emptyKeyboardMarkup
        }
      )
    }
  }
}

bot.command("mediate", async (ctx) => {
  if(ctx.message) {
    const chatId = ctx.message.chat.id;
    let chatMembers = await ctx.api.getChatMemberCount(chatId);
    if(chatMembers < 3) {
      ctx.reply(
        "You need to create mediations in a group chat with other people." + 
        "This is our private chat."
      );
    } else {
      const titleStart = ctx.message.text.indexOf(' ')
      const mediationTitle = ctx.message.text.substring(titleStart + 1, 256)
      if(titleStart == -1) {
        ctx.reply("When creating a new mediation, please provide a title as a reference like so: /mediate <i>title</i>");
      } else {
        lib.createMediation(mediationTitle, chatId)
          .then((mediation) => {
            const params = Buffer.from(mediation.id.chatId.toString() + '+' + mediation.id.id).toString('base64')
            const deepLink = `t.me/AIMediatorBot?start=` + params
            const keyboard = new InlineKeyboard()
              .url("participate", deepLink)

            ctx.reply(`Created mediation "${mediation.title}".`, {
              reply_markup: keyboard
            });
          })
          .catch((err) => {
            console.error('Failed to create mediation:', err);
            ctx.reply('Oops, something went wrong.');
          })
      }
    }
  } 
}) 

//handle callbacks
bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery!.data;
  if(!data) {
    console.warn('callback query without data', ctx.callbackQuery)
    return 
  }
  const params = data.split(' ')
  const action = params[0]
  if(action === Actions.closeMediation) {
    const chatId = parseInt(params[1])
    const id = params[2]
    const mediationId = {
      chatId,
      id
    }
    const jointId = lib.joinMediationId(mediationId)
    maybeRemoveCloseButtonFromPreviousMessage(ctx.api, jointId) 
    delete previousCloseButtonMessages[jointId] 

    lib.closeMediation(mediationId).then((mediationTitle) => {
      ctx.api.sendMessage(
        chatId, 
        `Mediation "${mediationTitle}" has been closed by ${makeMention(ctx.from!)}.`
      )
      const onAnswer = makeOnAnswerReady(ctx, mediationTitle)
      lib.checkWhetherMediationIsReadyAndConsultChatGPT(mediationId, onAnswer).then((status) => {
        if(status.finished) {
          ctx.api.sendMessage(
            chatId, 
            `I am reading through all your perspectives regarding mediation "${mediationTitle}". Check our private chat, I'll be writing to you.`
          )
        } else {
          ctx.api.sendMessage(
            chatId, 
            `So far received ${status.receivedPerspectivesCount} of ${status.participantCount} perspectives.` +
            `Waiting for the remaining ${status.participantCount! - status.receivedPerspectivesCount!}`
          )
        }
      })
    }) 
  }
})

function makeOnAnswerReady(ctx: Context, mediationTitle: string) {
  return (chatId: number, answer: string) => {
    ctx.api.sendMessage(
      chatId, 
      `Regarding mediation "${mediationTitle}": ${answer}`
    )
  }
}

bot.on("message", async (ctx) => {
  const userId = ctx.from.id
  const mediationId = usersCurrentMediations[userId]
  if(mediationId) {
    lib.storePerspective(mediationId, userId, ctx.message.text!).then((s1) => {
      let message = `Thank you for telling me your perspective for mediation "${s1.mediationTitle}".`
      if(s1.alreadyStored) {
        message = `You have overridden your perspective for mediation "${s1.mediationTitle}".`
      }
      ctx.reply(message)
      const intro = `${makeMention(ctx.from!)} has submitted their perspective on mediation "${s1.mediationTitle}".\n`
      if(s1.mediationClosed) {
        const onAnswer = makeOnAnswerReady(ctx, s1.mediationTitle)
        lib.checkWhetherMediationIsReadyAndConsultChatGPT(mediationId, onAnswer).then((s2) => {
          
          if(s2.finished) {
            ctx.api.sendMessage(
              mediationId.chatId, 
              `Now that everyone has submitted their perspective, let me read through all of them. I'll be writing to you in private chat.`
            )
          } else {
            if(s2.receivedPerspectivesCount == s2.participantCount) {
              if(s2.participantCount == 1) {
                ctx.api.sendMessage(
                  mediationId.chatId, 
                  intro + `Waiting for at least 2 participants.`
                )
              } else {
                const keyboard = new InlineKeyboard()
                  .text("close", Actions.closeMediation + ' ' + mediationId.chatId + ' ' + mediationId.id)

                ctx.api.sendMessage(
                  mediationId.chatId, intro + `If you want to get results, close the mediation.`, 
                  { 
                    reply_markup: keyboard
                  }
                )
                .then(msg => {
                  const jointId = lib.joinMediationId(mediationId)
                  maybeRemoveCloseButtonFromPreviousMessage(ctx.api, jointId)
                  previousCloseButtonMessages[jointId] = msg
                })
              }
            } else {
              ctx.api.sendMessage(
                mediationId.chatId, 
                intro + `So far I received ${s2.receivedPerspectivesCount} of ${s2.participantCount} perspectives.`
              )
            }
          }
        })
      } else {
        ctx.api.sendMessage(
          mediationId.chatId,
          intro
        )
      }
    })
  } else {
    ctx.reply(helpMessage)
  }
}) 

bot.start();

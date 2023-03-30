import dotenv from 'dotenv';
dotenv.config();

import * as lib from './lib';

import { Bot, InlineKeyboard } from "grammy";
import { User } from 'grammy/out/types.node';

const bot = new Bot(process.env.BOT_TOKEN!)

const helpMessage = `I am a bot based on ChatGPT that helps people to find solutions in interpersonal conflicts. You can initiate a new mediation with /mediate in any group chat. Anyone can participate and explain to me in a private chat, what's his perspective on the troublesome situation. Once everyone has done so and somebody notifies me with '/evalute', I'll send out a private message to each of you in which I try to make helpful suggestions on how to deal with the situation in a constructive way. `

const startErrorMessage = `Don't /start me manually in private chat. Follow a link by clicking on the participate button in a group chat instead. Create such a link in a group with the /mediate command.`

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
        const closeMessage = `Click on close if you don't expect any more participants`
        const keyboard = new InlineKeyboard()
          .text("close", Actions.closeMediation + ' ' + chatId + ' ' + id)

        ctx.api.sendMessage(
          chatId, joinMessage + " " + closeMessage, 
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
        ctx.api.sendMessage(chatId, joinMessage) 
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
    const titleStart = ctx.message.text.indexOf(' ')
    if(titleStart == -1) {
      ctx.reply("Provide a title when creating a new mediation");
    } else {
      const mediationTitle = ctx.message.text.substring(titleStart + 1, 256)
      const chatId = ctx.message.chat.id;
      let chatMembers = await ctx.api.getChatMemberCount(chatId);
      if(chatMembers < 3) {
        ctx.reply(
          "There is only you and me in this chat." + 
          "You need to create a mediation in a group chat with other people."
        );
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
      lib.checkWhetherMediationIsReadyAndConsultChatGPT(mediationId).then((status) => {
        if(status.finished) {
          ctx.api.sendMessage(
            chatId, 
            `Mediation results for "${mediationTitle}" are ready! Check your private chat.`
          )
        } else {
          ctx.api.sendMessage(
            chatId, 
            `So far received ${status.receivedPerspectivesCount} of ${status.participantCount} perspectives.`
          )
        }
      })
    }) 
  }
})

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
        lib.checkWhetherMediationIsReadyAndConsultChatGPT(mediationId).then((s2) => {
          
          if(s2.finished) {
            ctx.api.sendMessage(
              mediationId.chatId, 
              intro + `Mediation results are ready! Check your private chat.`
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

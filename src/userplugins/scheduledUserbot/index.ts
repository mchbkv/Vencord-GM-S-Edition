import { FluxDispatcher, PendingReplyStore } from "@webpack/common";
import definePlugin from "@utils/types";
import { sendMessage } from "@utils/discord";
import { sendBotMessage } from "@api/Commands";

const activeTimers: NodeJS.Timeout[] = [];

export default definePlugin({
    name: "ScheduledUserbot",
    description: "Отправка отложенных ответов через локальную слеш-команду",
    authors: [{ name: "Mikhail", id: 12345n }],

    commands: [{
        name: "schedule",
        description: "Запланировать отправку ответа",
        inputType: 0,
        type: 1,
        options: [
            {
                name: "period",
                description: "Период (например 1h, 1d, 30m, 10s)",
                type: 3,
                required: true
            },
            {
                name: "amount",
                description: "Количество раз",
                type: 4,
                required: true
            }
        ],

        execute(args: any[], ctx: any) {
            const periodStr = String(args.find((a: any) => a.name === "period")?.value) || "";
            const amount = Number(args.find((a: any) => a.name === "amount")?.value) || 1;

            const channelId = String(ctx.channel.id);
            const logChannelId = "PASTE_YOU_ID";

            let delayMs = 0;
            const match = periodStr.trim().match(/^(\d+(?:\.\d+)?)([hmds])$/i);
            if (match) {
                const val = parseFloat(match[1]);
                const unit = match[2].toLowerCase();
                if (unit === 'd') delayMs = val * 86400 * 1000;
                else if (unit === 'h') delayMs = val * 3600 * 1000;
                else if (unit === 'm') delayMs = val * 60 * 1000;
                else if (unit === 's') delayMs = val * 1000;
            } else {
                sendBotMessage(channelId, { content: "Неверный формат периода. Используйте 1h, 1d, 30m, 10s и т.д." });
                return;
            }

            const pendingReply = PendingReplyStore.getPendingReply(channelId);
            if (!pendingReply || !pendingReply.message) {
                sendBotMessage(channelId, { content: "Команду нужно вызывать в ответ (reply) на сообщение, которое вы хотите рассылать." });
                return;
            }

            FluxDispatcher.dispatch({ type: "DELETE_PENDING_REPLY", channelId: channelId });

            let textToSchedule = pendingReply.message.content || "";

            if (pendingReply.message.attachments && pendingReply.message.attachments.length > 0) {
                const attachmentUrls = pendingReply.message.attachments.map((a: any) => a.url).join("\n");
                textToSchedule += (textToSchedule ? "\n" : "") + attachmentUrls;
            }

            if (!textToSchedule) {
                sendBotMessage(channelId, { content: "Сообщение пустое." });
                return;
            }

            try {
                sendMessage(logChannelId, { content: `[ScheduledUserbot] Таймер запущен.\nПериод: **${periodStr}**\nКоличество: **${amount}** раз\nКанал: <#${channelId}>` });
            } catch (err) {
                console.error("Failed to send log:", err);
            }

            let count = 0;
            const timerId = setInterval(() => {
                count++;
                if (count > amount) {
                    clearInterval(timerId);
                    const index = activeTimers.indexOf(timerId);
                    if (index > -1) activeTimers.splice(index, 1);

                    try {
                        sendMessage(logChannelId, { content: `[ScheduledUserbot] Рассылка завершена для канала <#${channelId}>.` });
                    } catch (e) { }
                    return;
                }

                try {
                    sendMessage(channelId, { content: textToSchedule });
                } catch (err) {
                    console.error("[ScheduledUserbot] Критическая ошибка при отправке:", err);
                }
            }, delayMs);

            activeTimers.push(timerId);

            sendBotMessage(channelId, {
                content: `Таймер заведен. Период: ${periodStr}, количество: ${amount}. Оригинал: «${textToSchedule.substring(0, 50)}${textToSchedule.length > 50 ? "..." : ""}»`
            });
        }
    }],

    stop() {
        for (const timer of activeTimers) {
            clearInterval(timer);
        }
        activeTimers.length = 0;
    }
});
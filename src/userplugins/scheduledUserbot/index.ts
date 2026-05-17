/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { sendBotMessage } from "@api/Commands";
import { DataStore } from "@api/index";
import { sendMessage } from "@utils/discord";
import definePlugin from "@utils/types";
import { CloudUpload as TCloudUpload } from "@vencord/discord-types";
import { CloudUploadPlatform } from "@vencord/discord-types/enums";
import { findLazy } from "@webpack";
import { FluxDispatcher, PendingReplyStore, RestAPI, SnowflakeUtils } from "@webpack/common";

const CloudUpload: typeof TCloudUpload = findLazy(m => m.prototype?.trackUploadFinished);

const STORE_KEY = "ScheduledUserbot_schedules";
const LOG_CHANNEL_KEY = "ScheduledUserbot_logChannel";

interface ScheduleEntry {
    id: string;
    type?: "message" | "thread";
    channelId: string;
    content: string;
    attachmentUrls?: string[];
    title?: string;
    periodMs: number;
    periodStr: string;
    nextSendAt: number;
}

let activeTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
let currentLogChannelId: string | null = null;

function logToChannel(content: string) {
    if (currentLogChannelId) {
        try {
            sendMessage(currentLogChannelId, { content });
        } catch (_) {}
    }
}

async function loadSchedules(): Promise<ScheduleEntry[]> {
    return (await DataStore.get<ScheduleEntry[]>(STORE_KEY)) ?? [];
}

async function saveSchedules(schedules: ScheduleEntry[]): Promise<void> {
    await DataStore.set(STORE_KEY, schedules);
}

async function loadLogChannel(): Promise<string | null> {
    return (await DataStore.get<string>(LOG_CHANNEL_KEY)) ?? null;
}

async function saveLogChannel(id: string | null): Promise<void> {
    await DataStore.set(LOG_CHANNEL_KEY, id);
    currentLogChannelId = id;
}

function parsePeriod(periodStr: string): number | null {
    const match = periodStr.trim().match(/^(\d+(?:\.\d+)?)([hmds])$/i);
    if (!match) return null;
    const val = parseFloat(match[1]);
    const unit = match[2].toLowerCase();
    if (unit === "d") return val * 86400 * 1000;
    if (unit === "h") return val * 3600 * 1000;
    if (unit === "m") return val * 60 * 1000;
    if (unit === "s") return val * 1000;
    return null;
}

function parseFirstSend(str: string | undefined): number | null {
    if (!str) return null;
    const match = str.trim().match(/^(\d{1,2}):(\d{1,2}):(\d{1,2})$/);
    if (!match) return null;
    const d = parseInt(match[1]);
    const h = parseInt(match[2]);
    const m = parseInt(match[3]);
    if (h > 23 || m > 59) return null;
    return (d * 86400 + h * 3600 + m * 60) * 1000;
}

function generateId(): string {
    return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function scheduleNext(entry: ScheduleEntry): void {
    const now = Date.now();
    const delay = Math.max(0, entry.nextSendAt - now);

    const timerId = setTimeout(async () => {
        let success = true;
        let failReason = "";
        const entryType = entry.type || "message";

        try {
            const uploadedAttachments: any[] = [];
            if (entry.attachmentUrls && entry.attachmentUrls.length > 0) {
                for (let i = 0; i < entry.attachmentUrls.length; i++) {
                    const url = entry.attachmentUrls[i];
                    try {
                        const res = await fetch(url);
                        const blob = await res.blob();
                        const filename = url.split("/").pop()?.split("?")[0] || "file";
                        const file = new File([blob], filename, { type: blob.type });

                        const upload = new CloudUpload({
                            file,
                            isThumbnail: false,
                            platform: CloudUploadPlatform.WEB,
                        }, entry.channelId);

                        await new Promise((resolve, reject) => {
                            upload.on("complete", resolve);
                            upload.on("error", reject);
                            upload.upload();
                        });

                        uploadedAttachments.push({
                            id: String(i),
                            filename: upload.filename,
                            uploaded_filename: upload.uploadedFilename,
                        });
                    } catch (e) {
                        console.error("[ScheduledUserbot] Failed to upload attachment", url, e);
                    }
                }
            }

            if (entryType === "thread") {
                await RestAPI.post({
                    url: `/channels/${entry.channelId}/threads`,
                    body: {
                        name: entry.title,
                        message: {
                            content: entry.content,
                            attachments: uploadedAttachments
                        }
                    }
                });
            } else {
                await RestAPI.post({
                    url: `/channels/${entry.channelId}/messages`,
                    body: {
                        content: entry.content,
                        nonce: SnowflakeUtils.fromTimestamp(Date.now()),
                        type: 0,
                        attachments: uploadedAttachments
                    }
                });
            }
        } catch (err: any) {
            console.error("[ScheduledUserbot] Failed to send:", err);
            success = false;
            failReason = err?.body?.message || err?.message || String(err);
        }

        const schedules = await loadSchedules();
        const idx = schedules.findIndex(s => s.id === entry.id);
        if (idx === -1) return;

        schedules[idx].nextSendAt = Date.now() + entry.periodMs;
        await saveSchedules(schedules);

        if (success) {
            logToChannel(`[ScheduledUserbot] ✅ Успешно (${entryType}): **${entry.id}** в <#${entry.channelId}>. Следующий: <t:${Math.floor(schedules[idx].nextSendAt / 1000)}:R>`);
        } else {
            logToChannel(`[ScheduledUserbot] ❌ Ошибка (${entryType}): **${entry.id}** в <#${entry.channelId}>.\\nПричина: \`${failReason}\`\\nСледующая попытка: <t:${Math.floor(schedules[idx].nextSendAt / 1000)}:R>`);
        }

        scheduleNext(schedules[idx]);
    }, delay);

    activeTimers.set(entry.id, timerId);
}

async function startAllSchedules(): Promise<void> {
    const schedules = await loadSchedules();
    const now = Date.now();

    for (const entry of schedules) {
        if (activeTimers.has(entry.id)) continue;

        if (entry.nextSendAt <= now) {
            entry.nextSendAt = now + entry.periodMs;
        }

        scheduleNext(entry);
    }

    await saveSchedules(schedules);
}

function stopTimer(id: string): void {
    const timer = activeTimers.get(id);
    if (timer !== undefined) {
        clearTimeout(timer);
        activeTimers.delete(id);
    }
}

export default definePlugin({
    name: "ScheduledUserbot",
    description: "Persistent scheduled message sender that survives Discord restarts",
    authors: [{ name: "Mikhail", id: 12345n }],

    async start() {
        currentLogChannelId = await loadLogChannel();
        await startAllSchedules();
    },

    stop() {
        for (const [id] of activeTimers) {
            stopTimer(id);
        }
    },

    commands: [
        {
            name: "schedule",
            description: "Schedule a message from a reply to send repeatedly forever",
            inputType: 0,
            type: 1,
            options: [
                {
                    name: "period",
                    description: "Send interval (e.g. 2h, 30m, 1d)",
                    type: 3,
                    required: true
                },
                {
                    name: "first_send",
                    description: "Время первой отправки (формат dd:hh:mm)",
                    type: 3,
                    required: false
                }
            ],

            async execute(args: any[], ctx: any) {
                const channelId = String(ctx.channel.id);
                const periodStr = String(args.find((a: any) => a.name === "period")?.value ?? "");
                const firstSendStr = args.find((a: any) => a.name === "first_send")?.value;
                const periodMs = parsePeriod(periodStr);

                if (!periodMs) {
                    sendBotMessage(channelId, { content: "❌ Invalid period format. Use: `2h`, `30m`, `1d`, `10s`" });
                    return;
                }

                const pendingReply = PendingReplyStore.getPendingReply(channelId);
                if (!pendingReply?.message) {
                    sendBotMessage(channelId, { content: "❌ Use this command as a **reply** to the message you want to schedule." });
                    return;
                }

                FluxDispatcher.dispatch({ type: "DELETE_PENDING_REPLY", channelId });

                let content = pendingReply.message.content ?? "";
                let attachmentUrls: string[] = [];
                if (pendingReply.message.attachments?.length > 0) {
                    attachmentUrls = pendingReply.message.attachments.map((a: any) => a.url);
                }

                if (!content && attachmentUrls.length === 0) {
                    sendBotMessage(channelId, { content: "❌ The replied message is empty." });
                    return;
                }

                let nextSendAt = Date.now();
                if (firstSendStr) {
                    const firstSendMs = parseFirstSend(String(firstSendStr));
                    if (firstSendMs === null) {
                        sendBotMessage(channelId, { content: "❌ Неверный формат first_send. Используйте `dd:hh:mm` (например `01:12:30`)" });
                        return;
                    }
                    nextSendAt += firstSendMs;
                } else {
                    nextSendAt += periodMs;
                }

                const id = generateId();
                const entry: ScheduleEntry = { id, type: "message", channelId, content, attachmentUrls, periodMs, periodStr, nextSendAt };

                const schedules = await loadSchedules();
                schedules.push(entry);
                await saveSchedules(schedules);

                scheduleNext(entry);

                logToChannel(`[ScheduledUserbot] 🆕 Создана задача (message): **${id}** в <#${channelId}> каждые **${periodStr}**.`);

                sendBotMessage(channelId, {
                    content: `✅ Schedule **${id}** created! Sending to <#${channelId}> every **${periodStr}**.\nNext send: <t:${Math.floor(nextSendAt / 1000)}:R>\nPreview: \`${content.slice(0, 60)}${content.length > 60 ? "..." : ""}\``
                });
            }
        },

        {
            name: "schedule_thread",
            description: "Создавать публикации в форуме с заданным интервалом",
            inputType: 0,
            type: 1,
            options: [
                {
                    name: "id",
                    description: "ID канала-форума",
                    type: 3,
                    required: true
                },
                {
                    name: "period",
                    description: "Период отправки (10h, 10m, 10d)",
                    type: 3,
                    required: true
                },
                {
                    name: "title",
                    description: "Заголовок публикации (до 100 символов)",
                    type: 3,
                    required: true
                },
                {
                    name: "first_send",
                    description: "Время первой отправки (формат dd:hh:mm)",
                    type: 3,
                    required: false
                }
            ],
            async execute(args: any[], ctx: any) {
                const commandChannelId = String(ctx.channel.id);
                const forumId = String(args.find((a: any) => a.name === "id")?.value ?? "").trim();
                const periodStr = String(args.find((a: any) => a.name === "period")?.value ?? "");
                const title = String(args.find((a: any) => a.name === "title")?.value ?? "").slice(0, 100);
                const firstSendStr = args.find((a: any) => a.name === "first_send")?.value;

                const periodMs = parsePeriod(periodStr);
                if (!periodMs) {
                    sendBotMessage(commandChannelId, { content: "❌ Неверный формат периода. Используйте: `2h`, `30m`, `1d`, `10s`" });
                    return;
                }

                const pendingReply = PendingReplyStore.getPendingReply(commandChannelId);
                if (!pendingReply?.message) {
                    sendBotMessage(commandChannelId, { content: "❌ Ответьте на сообщение, которое хотите опубликовать." });
                    return;
                }

                FluxDispatcher.dispatch({ type: "DELETE_PENDING_REPLY", channelId: commandChannelId });

                let message = pendingReply.message.content ?? "";
                let attachmentUrls: string[] = [];
                if (pendingReply.message.attachments?.length > 0) {
                    attachmentUrls = pendingReply.message.attachments.map((a: any) => a.url);
                }

                if (!message && attachmentUrls.length === 0) {
                    sendBotMessage(commandChannelId, { content: "❌ Сообщение пустое." });
                    return;
                }

                let nextSendAt = Date.now();
                if (firstSendStr) {
                    const firstSendMs = parseFirstSend(String(firstSendStr));
                    if (firstSendMs === null) {
                        sendBotMessage(commandChannelId, { content: "❌ Неверный формат first_send. Используйте `dd:hh:mm` (например `01:12:30`)" });
                        return;
                    }
                    nextSendAt += firstSendMs;
                } else {
                    nextSendAt += periodMs;
                }

                const id = generateId();
                const entry: ScheduleEntry = { 
                    id, 
                    type: "thread", 
                    channelId: forumId, 
                    content: message, 
                    attachmentUrls,
                    title, 
                    periodMs, 
                    periodStr, 
                    nextSendAt 
                };

                const schedules = await loadSchedules();
                schedules.push(entry);
                await saveSchedules(schedules);

                scheduleNext(entry);

                logToChannel(`[ScheduledUserbot] 🆕 Создана задача (thread): **${id}** в <#${forumId}> каждые **${periodStr}**.`);

                sendBotMessage(commandChannelId, {
                    content: `✅ Задача (Форум) **${id}** создана! Публикация в <#${forumId}> каждые **${periodStr}**.\nПервая отправка: <t:${Math.floor(nextSendAt / 1000)}:R>\nЗаголовок: \`${title}\``
                });
            }
        },

        {
            name: "logmess",
            description: "Установить канал для логов (ошибки и статусы отправки)",
            inputType: 0,
            type: 1,
            options: [
                {
                    name: "id",
                    description: "ID канала для логов",
                    type: 3,
                    required: true
                }
            ],
            async execute(args: any[], ctx: any) {
                const commandChannelId = String(ctx.channel.id);
                const logId = String(args.find((a: any) => a.name === "id")?.value ?? "").trim();
                
                await saveLogChannel(logId);
                sendBotMessage(commandChannelId, { content: `✅ Канал для логов установлен: <#${logId}>.` });
            }
        },

        {
            name: "schedule_list",
            description: "List all active scheduled messages",
            inputType: 0,
            type: 1,
            options: [],

            async execute(_args: any[], ctx: any) {
                const channelId = String(ctx.channel.id);
                const schedules = await loadSchedules();

                const logStatus = currentLogChannelId ? `✅ Канал для логов: <#${currentLogChannelId}>` : `❌ Канал для логов НЕ установлен (используйте /logmess)`;

                if (schedules.length === 0) {
                    sendBotMessage(channelId, { content: `${logStatus}\n\n📭 Нет активных задач.` });
                    return;
                }

                const lines = schedules.map(s => {
                    const typeLabel = s.type === "thread" ? `[Форум "${s.title}"]` : `[Сообщение]`;
                    return `**[${s.id}]** ${typeLabel} → <#${s.channelId}> каждые **${s.periodStr}** | След: <t:${Math.floor(s.nextSendAt / 1000)}:R>\n> \`${s.content.slice(0, 60)}${s.content.length > 60 ? "..." : ""}\``;
                });

                sendBotMessage(channelId, { content: `📋 **Scheduled Messages (${schedules.length}):**\n${logStatus}\n\n${lines.join("\n\n")}` });
            }
        },

        {
            name: "schedule_remove",
            description: "Remove a scheduled message by its ID",
            inputType: 0,
            type: 1,
            options: [
                {
                    name: "id",
                    description: "Schedule ID (from /schedule_list)",
                    type: 3,
                    required: true
                }
            ],

            async execute(args: any[], ctx: any) {
                const channelId = String(ctx.channel.id);
                const id = String(args.find((a: any) => a.name === "id")?.value ?? "").toUpperCase();

                const schedules = await loadSchedules();
                const idx = schedules.findIndex(s => s.id === id);

                if (idx === -1) {
                    sendBotMessage(channelId, { content: `❌ Schedule **${id}** not found.` });
                    return;
                }

                stopTimer(id);
                schedules.splice(idx, 1);
                await saveSchedules(schedules);

                logToChannel(`[ScheduledUserbot] 🗑️ Удалена задача: **${id}**`);

                sendBotMessage(channelId, { content: `🗑️ Schedule **${id}** removed.` });
            }
        },

        {
            name: "schedule_resume",
            description: "Resume all schedules after a restart (rechecks dates)",
            inputType: 0,
            type: 1,
            options: [],

            async execute(_args: any[], ctx: any) {
                const channelId = String(ctx.channel.id);

                for (const [id] of activeTimers) {
                    stopTimer(id);
                }

                await startAllSchedules();
                const schedules = await loadSchedules();
                
                const logStatus = currentLogChannelId ? `Канал логов активен: <#${currentLogChannelId}>.` : `Канал логов не установлен.`;

                sendBotMessage(channelId, { content: `▶️ Resumed **${schedules.length}** schedule(s). ${logStatus}` });
            }
        }
    ]
});

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
import { FluxDispatcher, PendingReplyStore } from "@webpack/common";

const STORE_KEY = "ScheduledUserbot_schedules";
const LOG_CHANNEL_ID = "PASTE_YOUR_LOG_CHANNEL_ID_HERE";

interface ScheduleEntry {
    id: string;
    channelId: string;
    content: string;
    periodMs: number;
    periodStr: string;
    nextSendAt: number;
}

let activeTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

async function loadSchedules(): Promise<ScheduleEntry[]> {
    return (await DataStore.get<ScheduleEntry[]>(STORE_KEY)) ?? [];
}

async function saveSchedules(schedules: ScheduleEntry[]): Promise<void> {
    await DataStore.set(STORE_KEY, schedules);
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

function generateId(): string {
    return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function scheduleNext(entry: ScheduleEntry): void {
    const now = Date.now();
    const delay = Math.max(0, entry.nextSendAt - now);

    const timerId = setTimeout(async () => {
        try {
            sendMessage(entry.channelId, { content: entry.content });
        } catch (err) {
            console.error("[ScheduledUserbot] Failed to send message:", err);
        }

        const schedules = await loadSchedules();
        const idx = schedules.findIndex(s => s.id === entry.id);
        if (idx === -1) return;

        schedules[idx].nextSendAt = Date.now() + entry.periodMs;
        await saveSchedules(schedules);

        try {
            sendMessage(LOG_CHANNEL_ID, {
                content: `[ScheduledUserbot] ✅ Sent **${entry.id}** to <#${entry.channelId}>. Next: <t:${Math.floor(schedules[idx].nextSendAt / 1000)}:R>`
            });
        } catch (_) { }

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
                }
            ],

            async execute(args: any[], ctx: any) {
                const channelId = String(ctx.channel.id);
                const periodStr = String(args.find((a: any) => a.name === "period")?.value ?? "");
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
                if (pendingReply.message.attachments?.length > 0) {
                    const urls = pendingReply.message.attachments.map((a: any) => a.url).join("\n");
                    content += (content ? "\n" : "") + urls;
                }

                if (!content) {
                    sendBotMessage(channelId, { content: "❌ The replied message is empty." });
                    return;
                }

                const id = generateId();
                const nextSendAt = Date.now() + periodMs;
                const entry: ScheduleEntry = { id, channelId, content, periodMs, periodStr, nextSendAt };

                const schedules = await loadSchedules();
                schedules.push(entry);
                await saveSchedules(schedules);

                scheduleNext(entry);

                sendBotMessage(channelId, {
                    content: `✅ Schedule **${id}** created! Sending to <#${channelId}> every **${periodStr}**.\nNext send: <t:${Math.floor(nextSendAt / 1000)}:R>\nPreview: \`${content.slice(0, 60)}${content.length > 60 ? "..." : ""}\``
                });
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

                if (schedules.length === 0) {
                    sendBotMessage(channelId, { content: "📭 No scheduled messages." });
                    return;
                }

                const lines = schedules.map(s =>
                    `**[${s.id}]** → <#${s.channelId}> every **${s.periodStr}** | Next: <t:${Math.floor(s.nextSendAt / 1000)}:R>\n> \`${s.content.slice(0, 60)}${s.content.length > 60 ? "..." : ""}\``
                );

                sendBotMessage(channelId, { content: `📋 **Scheduled Messages (${schedules.length}):**\n\n${lines.join("\n\n")}` });
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

                sendBotMessage(channelId, { content: `▶️ Resumed **${schedules.length}** schedule(s).` });
            }
        }
    ]
});
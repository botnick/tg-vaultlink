/**
 * Bot command list for `setMyCommands`.
 *
 * Wave 7 simplification: the public, advertised command surface is intentionally
 * tiny. Legacy commands (`/my_files`, `/add_bot`, `/del`, `/set_password`, etc.)
 * still work — their handlers remain registered as hidden aliases for power
 * users — but they are NOT surfaced in the Telegram client menu.
 *
 * `/admin` is omitted from the public list and registered separately at boot
 * via `setMyCommands(scope=chat, chat_id=adminId)` so it only appears in the
 * client menu for known administrators.
 */

import type { BotCommand } from 'grammy/types';

export const PUBLIC_BOT_COMMANDS: readonly BotCommand[] = [
  { command: 'start', description: 'เปิดเมนูหลัก / Open main menu' },
  { command: 'help', description: 'วิธีใช้งาน / How to use' },
  { command: 'new', description: 'สร้างรหัสแชร์ / Create a share' },
  { command: 'files', description: 'ไฟล์ของฉัน / My files' },
  { command: 'bots', description: 'บอทส่วนตัว / My bots' },
  { command: 'settings', description: 'ตั้งค่า / Settings' },
  { command: 'cancel', description: 'ยกเลิก / Cancel' },
] as const;

/** The single admin-only command, registered per-chat at boot. */
export const ADMIN_BOT_COMMAND: BotCommand = {
  command: 'admin',
  description: 'Admin dashboard',
};

/**
 * Back-compat alias. The legacy bootstrap path called `setMyCommands` against
 * the full `BOT_COMMANDS` array; it now collapses to {@link PUBLIC_BOT_COMMANDS}
 * so existing imports continue to work without surfacing legacy commands.
 */
export const BOT_COMMANDS: readonly BotCommand[] = PUBLIC_BOT_COMMANDS;

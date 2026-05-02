/**
 * Re-usable handler for the `/help` command body.
 *
 * Lives in its own file so the main-menu router can fire `/help` from a
 * callback query without importing the router that registers the command.
 */

import type { AppContext } from '../context.js';

export async function handleHelpCommand(ctx: AppContext): Promise<void> {
  const body = [ctx.t('help.intro'), ctx.t('help.commands_list')].join('\n\n');
  await ctx.reply(body, { parse_mode: 'HTML' });
}

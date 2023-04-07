/* eslint-disable @typescript-eslint/no-unused-vars */
import { inspect } from 'node:util';

import { codeBlock, userMention } from '@discordjs/builders';
import { ClientStorage, economy_transaction_type } from '@prisma/client';
import { Stopwatch } from '@sapphire/stopwatch';
import { Duration } from '@sapphire/time-utilities';
import { isThenable } from '@sentry/utils';
import { AttachmentBuilder, escapeCodeBlock, InteractionReplyOptions } from 'discord.js';
import { notEmpty, randArrItem, sleep, Time, uniqueArr } from 'e';
import { ApplicationCommandOptionType, CommandRunOptions } from 'mahoji';
import { CommandResponse } from 'mahoji/dist/lib/structures/ICommand';
import { MahojiUserOption } from 'mahoji/dist/lib/types';
import { bulkUpdateCommands } from 'mahoji/dist/lib/util';
import { Bank } from 'oldschooljs';
import { ItemBank } from 'oldschooljs/dist/meta/types';

import { ADMIN_IDS, OWNER_IDS, production, SupportServer } from '../../config';
import { BLACKLISTED_GUILDS, BLACKLISTED_USERS, syncBlacklists } from '../../lib/blacklists';
import { boxFrenzy } from '../../lib/boxFrenzy';
import {
	badges,
	BadgesEnum,
	BitField,
	BitFieldData,
	Channel,
	DISABLED_COMMANDS,
	globalConfig
} from '../../lib/constants';
import { slayerMaskHelms } from '../../lib/data/slayerMaskHelms';
import { addToDoubleLootTimer } from '../../lib/doubleLoot';
import { generateGearImage } from '../../lib/gear/functions/generateGearImage';
import { GearSetup } from '../../lib/gear/types';
import { mahojiUserSettingsUpdate } from '../../lib/MUser';
import { patreonTask } from '../../lib/patreon';
import { runRolesTask } from '../../lib/rolesTask';
import { countUsersWithItemInCl, prisma } from '../../lib/settings/prisma';
import { cancelTask, minionActivityCacheDelete } from '../../lib/settings/settings';
import { sorts } from '../../lib/sorts';
import { Gear } from '../../lib/structures/Gear';
import {
	calcPerHour,
	cleanString,
	convertBankToPerHourStats,
	formatDuration,
	sanitizeBank,
	stringMatches,
	toKMB
} from '../../lib/util';
import { memoryAnalysis } from '../../lib/util/cachedUserIDs';
import { mahojiClientSettingsFetch, mahojiClientSettingsUpdate } from '../../lib/util/clientSettings';
import getOSItem, { getItem } from '../../lib/util/getOSItem';
import { handleMahojiConfirmation } from '../../lib/util/handleMahojiConfirmation';
import { deferInteraction, interactionReply } from '../../lib/util/interactionReply';
import { syncLinkedAccounts } from '../../lib/util/linkedAccountsUtil';
import { logError } from '../../lib/util/logError';
import { makeBankImage } from '../../lib/util/makeBankImage';
import { parseBank } from '../../lib/util/parseStringBank';
import { slayerMaskLeaderboardCache } from '../../lib/util/slayerMaskLeaderboard';
import { sendToChannelID } from '../../lib/util/webhook';
import { Cooldowns } from '../lib/Cooldowns';
import { syncCustomPrices } from '../lib/events';
import { itemOption } from '../lib/mahojiCommandOptions';
import { allAbstractCommands, OSBMahojiCommand } from '../lib/util';
import { mahojiUsersSettingsFetch } from '../mahojiSettings';
import { getUserInfo } from './minion';

export const gifs = [
	'https://tenor.com/view/angry-stab-monkey-knife-roof-gif-13841993',
	'https://gfycat.com/serenegleamingfruitbat',
	'https://tenor.com/view/monkey-monito-mask-gif-23036908'
];

async function unsafeEval({ userID, code }: { userID: string; code: string }) {
	if (!OWNER_IDS.includes(userID)) return { content: 'Unauthorized' };
	code = code.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
	const stopwatch = new Stopwatch();
	let syncTime = '?';
	let asyncTime = '?';
	let result = null;
	let thenable = false;
	// eslint-disable-next-line @typescript-eslint/init-declarations
	try {
		code = `\nconst {Gear} = require('../../lib/structures/Gear')\n${code};`;
		code = `\nconst {Bank} = require('oldschooljs');\n${code}`;
		// eslint-disable-next-line no-eval
		result = eval(code);
		syncTime = stopwatch.toString();
		if (isThenable(result)) {
			thenable = true;
			stopwatch.restart();
			result = await result;
			asyncTime = stopwatch.toString();
		}
	} catch (error: any) {
		if (!syncTime) syncTime = stopwatch.toString();
		if (thenable && !asyncTime) asyncTime = stopwatch.toString();
		if (error && error.stack) logError(error);
		result = error;
	}

	stopwatch.stop();
	if (result instanceof Bank) {
		return { files: [(await makeBankImage({ bank: result })).file] };
	}
	if (result instanceof Gear) {
		const image = await generateGearImage(await mUserFetch(userID), result, null, null);
		return { files: [image] };
	}

	if (Buffer.isBuffer(result)) {
		return {
			content: 'The result was a buffer.',
			files: [result]
		};
	}

	if (typeof result !== 'string') {
		result = inspect(result, {
			depth: 1,
			showHidden: false
		});
	}

	return {
		content: `${codeBlock(escapeCodeBlock(result))}
**Time:** ${asyncTime ? `⏱ ${asyncTime}<${syncTime}>` : `⏱ ${syncTime}`}
`
	};
}

async function evalCommand(userID: string, code: string): CommandResponse {
	try {
		if (!OWNER_IDS.includes(userID)) {
			return "You don't have permission to use this command.";
		}
		const res = await unsafeEval({ code, userID });

		if (res.content && res.content.length > 2000) {
			return {
				files: [{ attachment: Buffer.from(res.content), name: 'output.txt' }]
			};
		}

		return res;
	} catch (err: any) {
		return err.message ?? err;
	}
}

async function getAllTradedItems(giveUniques = false) {
	const economyTrans = await prisma.economyTransaction.findMany({
		where: {
			date: {
				gt: new Date(Date.now() - Time.Month)
			},
			type: economy_transaction_type.trade
		},
		select: {
			items_received: true,
			items_sent: true
		}
	});

	let total = new Bank();

	if (giveUniques) {
		for (const trans of economyTrans) {
			let bank = new Bank().add(trans.items_received as ItemBank).add(trans.items_sent as ItemBank);

			for (const item of bank.items()) {
				total.add(item[0].id);
			}
		}
	} else {
		for (const trans of economyTrans) {
			total.add(trans.items_received as ItemBank);
			total.add(trans.items_sent as ItemBank);
		}
	}

	return total;
}

const viewableThings: {
	name: string;
	run: (clientSettings: ClientStorage) => Promise<Bank | InteractionReplyOptions>;
}[] = [
	{
		name: 'ToB Cost',
		run: async clientSettings => {
			return new Bank(clientSettings.tob_cost as ItemBank);
		}
	},
	{
		name: 'Invention Disassembly Cost',
		run: async clientSettings => {
			return new Bank(clientSettings.items_disassembled_cost as ItemBank);
		}
	},
	{
		name: 'All Equipped Items',
		run: async () => {
			const res = await prisma.$queryRaw<Record<string, GearSetup | null>[]>`SELECT "gear.melee",
"gear.mage",
"gear.range",
"gear.misc",
"gear.skilling",
"gear.wildy",
"gear.fashion",
"gear.other"
FROM users
WHERE last_command_date > now() - INTERVAL '1 weeks'
AND ("gear.melee" IS NOT NULL OR
"gear.mage" IS NOT NULL OR
"gear.range" IS NOT NULL OR
"gear.misc" IS NOT NULL OR
"gear.skilling" IS NOT NULL OR
"gear.wildy" IS NOT NULL OR
"gear.fashion" IS NOT NULL OR
"gear.other" IS NOT NULL);`;
			const bank = new Bank();
			for (const user of res) {
				for (const gear of Object.values(user)
					.map(i => (i === null ? [] : Object.values(i)))
					.flat()
					.filter(notEmpty)) {
					let item = getItem(gear.item);
					if (item) {
						bank.add(gear.item, gear.quantity);
					}
				}
			}
			return bank;
		}
	},
	{
		name: 'Most Traded Items (30d, Total Volume)',
		run: async () => {
			const items = await getAllTradedItems();
			return {
				content: items
					.items()
					.sort(sorts.quantity)
					.slice(0, 10)
					.map((i, index) => `${++index}. ${i[0].name} - ${i[1].toLocaleString()}x traded`)
					.join('\n')
			};
		}
	},
	{
		name: 'Most Traded Items (30d, Unique trades)',
		run: async () => {
			const items = await getAllTradedItems(true);
			return {
				content: items
					.items()
					.sort(sorts.quantity)
					.slice(0, 10)
					.map((i, index) => `${++index}. ${i[0].name} - Traded ${i[1].toLocaleString()}x times`)
					.join('\n')
			};
		}
	},
	{
		name: 'Memory Analysis',
		run: async () => {
			return {
				content: Object.entries(memoryAnalysis())
					.map(i => `${i[0]}: ${i[1]}`)
					.join('\n')
			};
		}
	},
	{
		name: 'Slayer Mask Leaderboard',
		run: async () => {
			let res = '';

			for (const [maskID, userID] of slayerMaskLeaderboardCache.entries()) {
				const mask = slayerMaskHelms.find(i => i.mask.id === maskID);
				if (!mask) continue;
				res += `${mask.mask.name}: ${userMention(userID)}\n`;
			}

			return {
				content: res,
				allowedMentions: {
					users: []
				}
			};
		}
	}
];

export const adminCommand: OSBMahojiCommand = {
	name: 'admin',
	description: 'Allows you to trade items with other players.',
	guildID: SupportServer,
	options: [
		{
			type: ApplicationCommandOptionType.Subcommand,
			name: 'add_patron_time',
			description: 'Give user temporary patron time.',
			options: [
				{
					type: ApplicationCommandOptionType.User,
					name: 'user',
					description: 'The user.',
					required: true
				},
				{
					type: ApplicationCommandOptionType.Integer,
					name: 'tier',
					description: 'The tier to give.',
					required: true,
					choices: [1, 2, 3, 4, 5, 6].map(i => ({ name: i.toString(), value: i }))
				},
				{
					type: ApplicationCommandOptionType.String,
					name: 'time',
					description: 'The time.',
					required: true
				}
			]
		},
		{
			type: ApplicationCommandOptionType.Subcommand,
			name: 'viewbank',
			description: 'View a users bank.',
			options: [
				{
					type: ApplicationCommandOptionType.User,
					name: 'user',
					description: 'The user.',
					required: true
				}
			]
		},
		{
			type: ApplicationCommandOptionType.Subcommand,
			name: 'reboot',
			description: 'Reboot the bot.'
		},
		{
			type: ApplicationCommandOptionType.Subcommand,
			name: 'eval',
			description: 'Eval.',
			options: [
				{
					type: ApplicationCommandOptionType.String,
					name: 'code',
					description: 'Code',
					required: true
				}
			]
		},
		{
			type: ApplicationCommandOptionType.Subcommand,
			name: 'sync_commands',
			description: 'Sync commands',
			options: []
		},
		{
			type: ApplicationCommandOptionType.Subcommand,
			name: 'item_stats',
			description: 'item stats',
			options: [{ ...itemOption(), required: true }]
		},
		{
			type: ApplicationCommandOptionType.Subcommand,
			name: 'sync_blacklist',
			description: 'Sync blacklist'
		},
		{
			type: ApplicationCommandOptionType.Subcommand,
			name: 'loot_track',
			description: 'Loot track',
			options: [
				{
					type: ApplicationCommandOptionType.String,
					name: 'name',
					description: 'The name',
					autocomplete: async (value: string) => {
						const tracks = await prisma.lootTrack.findMany({ select: { id: true } });
						return tracks
							.filter(i => (!value ? true : i.id.includes(value)))
							.map(i => ({ name: i.id, value: i.id }));
					},
					required: true
				}
			]
		},
		//
		{
			type: ApplicationCommandOptionType.Subcommand,
			name: 'cancel_task',
			description: 'Cancel a users task',
			options: [
				{
					type: ApplicationCommandOptionType.User,
					name: 'user',
					description: 'The user',
					required: true
				}
			]
		},
		{
			type: ApplicationCommandOptionType.Subcommand,
			name: 'bypass_age',
			description: 'Bypass age for a user',
			options: [
				{
					type: ApplicationCommandOptionType.User,
					name: 'user',
					description: 'The user',
					required: true
				}
			]
		},
		{
			type: ApplicationCommandOptionType.Subcommand,
			name: 'sync_roles',
			description: 'Sync roles'
		},
		{
			type: ApplicationCommandOptionType.Subcommand,
			name: 'sync_patreon',
			description: 'Sync patreon'
		},
		{
			type: ApplicationCommandOptionType.Subcommand,
			name: 'add_ironman_alt',
			description: 'Add an ironman alt account for a user',
			options: [
				{
					type: ApplicationCommandOptionType.User,
					name: 'main',
					description: 'The main',
					required: true
				},
				{
					type: ApplicationCommandOptionType.User,
					name: 'ironman_alt',
					description: 'The ironman alt',
					required: true
				}
			]
		},
		{
			type: ApplicationCommandOptionType.Subcommand,
			name: 'badges',
			description: 'Manage badges of a user',
			options: [
				{
					type: ApplicationCommandOptionType.User,
					name: 'user',
					description: 'The user',
					required: true
				},
				{
					type: ApplicationCommandOptionType.String,
					name: 'add',
					description: 'The badge to add',
					required: false,
					autocomplete: async () => {
						return Object.keys(BadgesEnum).map(i => ({ name: i, value: i }));
					}
				},
				{
					type: ApplicationCommandOptionType.String,
					name: 'remove',
					description: 'The badge to remove',
					required: false,
					autocomplete: async () => {
						return Object.keys(BadgesEnum).map(i => ({ name: i, value: i }));
					}
				}
			]
		},
		{
			type: ApplicationCommandOptionType.Subcommand,
			name: 'command',
			description: 'Enable/disable commands',
			options: [
				{
					type: ApplicationCommandOptionType.String,
					name: 'disable',
					description: 'The command to disable',
					required: false,
					autocomplete: async (value: string) => {
						const disabledCommands = Array.from(DISABLED_COMMANDS.values());
						return allAbstractCommands(globalClient.mahojiClient)
							.filter(i => !disabledCommands.includes(i.name))
							.filter(i => (!value ? true : i.name.toLowerCase().includes(value.toLowerCase())))
							.map(i => ({ name: i.name, value: i.name }));
					}
				},
				{
					type: ApplicationCommandOptionType.String,
					name: 'enable',
					description: 'The command to enable',
					required: false,
					autocomplete: async () => {
						const disabledCommands = Array.from(DISABLED_COMMANDS.values());
						return allAbstractCommands(globalClient.mahojiClient)
							.filter(i => disabledCommands.includes(i.name))
							.map(i => ({ name: i.name, value: i.name }));
					}
				}
			]
		},
		{
			type: ApplicationCommandOptionType.Subcommand,
			name: 'view_user',
			description: 'View a users info',
			options: [
				{
					type: ApplicationCommandOptionType.User,
					name: 'user',
					description: 'The user',
					required: true
				}
			]
		},
		{
			type: ApplicationCommandOptionType.Subcommand,
			name: 'set_price',
			description: 'item stats',
			options: [
				{ ...itemOption(), required: true },
				{
					type: ApplicationCommandOptionType.Integer,
					name: 'price',
					description: 'The price to set',
					required: true,
					min_value: 1
				}
			]
		},
		{
			type: ApplicationCommandOptionType.Subcommand,
			name: 'most_active',
			description: 'Most active'
		},
		{
			type: ApplicationCommandOptionType.Subcommand,
			name: 'bitfield',
			description: 'Manage bitfield of a user',
			options: [
				{
					type: ApplicationCommandOptionType.User,
					name: 'user',
					description: 'The user',
					required: true
				},
				{
					type: ApplicationCommandOptionType.String,
					name: 'add',
					description: 'The bitfield to add',
					required: false,
					autocomplete: async () => {
						return Object.entries(BitFieldData).map(i => ({ name: i[1].name, value: i[0] }));
					}
				},
				{
					type: ApplicationCommandOptionType.String,
					name: 'remove',
					description: 'The bitfield to remove',
					required: false,
					autocomplete: async () => {
						return Object.entries(BitFieldData).map(i => ({ name: i[1].name, value: i[0] }));
					}
				}
			]
		},
		{
			type: ApplicationCommandOptionType.Subcommand,
			name: 'ltc',
			description: 'Ltc?',
			options: [
				{
					...itemOption(),
					name: 'item',
					description: 'The item.',
					required: false
				}
			]
		},
		{
			type: ApplicationCommandOptionType.Subcommand,
			name: 'double_loot',
			description: 'Manage double loot',
			options: [
				{
					type: ApplicationCommandOptionType.Boolean,
					name: 'reset',
					description: 'Reset double loot',
					required: false
				},
				{
					type: ApplicationCommandOptionType.String,
					name: 'add',
					description: 'Add double loot time',
					required: false
				}
			]
		},
		{
			type: ApplicationCommandOptionType.Subcommand,
			name: 'givetgb',
			description: 'Give em a tgb',
			options: [
				{
					type: ApplicationCommandOptionType.User,
					name: 'user',
					description: 'The user',
					required: true
				}
			]
		},
		{
			type: ApplicationCommandOptionType.Subcommand,
			name: 'view',
			description: 'View something',
			options: [
				{
					type: ApplicationCommandOptionType.String,
					name: 'thing',
					description: 'The thing',
					required: true,
					choices: viewableThings.map(i => ({ name: i.name, value: i.name }))
				}
			]
		},
		// {
		// 	type: ApplicationCommandOptionType.Subcommand,
		// 	name: 'wipe_bingo_temp_cls',
		// 	description: 'Wipe all temp cls of bingo users'
		// },
		{
			type: ApplicationCommandOptionType.Subcommand,
			name: 'give_items',
			description: 'Spawn items for a user',
			options: [
				{
					type: ApplicationCommandOptionType.User,
					name: 'user',
					description: 'The user',
					required: true
				},
				{
					type: ApplicationCommandOptionType.String,
					name: 'items',
					description: 'The items to give',
					required: true
				},
				{
					type: ApplicationCommandOptionType.String,
					name: 'reason',
					description: 'The reason'
				}
			]
		},
		{
			type: ApplicationCommandOptionType.Subcommand,
			name: 'box_frenzy',
			description: 'Box frenzy',
			options: [
				{
					type: ApplicationCommandOptionType.Integer,
					name: 'amount',
					description: 'The amount',
					required: true,
					min_value: 1,
					max_value: 500
				}
			]
		}
	],
	run: async ({
		options,
		userID,
		interaction,
		guildID,
		channelID
	}: CommandRunOptions<{
		givetgb?: { user: MahojiUserOption };
		viewbank?: { user: MahojiUserOption };
		reboot?: {};
		debug_patreon?: {};
		eval?: { code: string };
		sync_commands?: {};
		item_stats?: { item: string };
		sync_blacklist?: {};
		loot_track?: { name: string };
		cancel_task?: { user: MahojiUserOption };
		add_patron_time?: { user: MahojiUserOption; tier: number; time: string };
		sync_roles?: {};
		sync_patreon?: {};
		add_ironman_alt?: { main: MahojiUserOption; ironman_alt: MahojiUserOption };
		badges?: { user: MahojiUserOption; add?: string; remove?: string };
		bypass_age?: { user: MahojiUserOption };
		command?: { enable?: string; disable?: string };
		view_user?: { user: MahojiUserOption };
		set_price?: { item: string; price: number };
		most_active?: {};
		bitfield?: { user: MahojiUserOption; add?: string; remove?: string };
		ltc?: { item?: string };
		double_loot?: { reset?: boolean; add?: string };
		view?: { thing: string };
		wipe_bingo_temp_cls?: {};
		give_items?: { user: MahojiUserOption; items: string; reason?: string };
		box_frenzy?: { amount: number };
	}>) => {
		await deferInteraction(interaction);

		const adminUser = await mUserFetch(userID);
		const isContributor = adminUser.bitfield.includes(BitField.isContributor);
		const isOwner = OWNER_IDS.includes(userID.toString());
		const isMod = isOwner || adminUser.bitfield.includes(BitField.isModerator);

		/**
		 *
		 * Contributor Commands
		 *
		 */
		if (!guildID || (production && guildID.toString() !== SupportServer)) return randArrItem(gifs);

		// if (options.wipe_bingo_temp_cls) {
		// 	if (userID.toString() !== '319396464402890753' && !isMod) return randArrItem(gifs);
		// 	const usersToReset = await prisma.user.findMany({
		// 		where: {
		// 			bingo_tickets_bought: {
		// 				gt: 0
		// 			}
		// 		},
		// 		select: {
		// 			id: true
		// 		}
		// 	});
		// 	await handleMahojiConfirmation(interaction, `Reset the temp CL of ${usersToReset.length} users?`);
		// 	const res = await prisma.user.updateMany({
		// 		where: {
		// 			id: {
		// 				in: usersToReset.map(i => i.id)
		// 			}
		// 		},
		// 		data: {
		// 			temp_cl: {}
		// 		}
		// 	});
		// 	return `${res.count} temp CLs reset.`;
		// }

		if (!isMod && !isContributor) return randArrItem(gifs);
		if (options.givetgb) {
			const user = await mUserFetch(options.givetgb.user.user.id);
			if (user.id === adminUser.id) {
				return randArrItem(gifs);
			}
			await user.addItemsToBank({ items: new Bank().add('Tester gift box'), collectionLog: true });
			return `Gave 1x Tester gift box to ${user}.`;
		}
		/**
		 *
		 * Mod Only Commands
		 *
		 */
		if (!isMod) return randArrItem(gifs);
		if (options.cancel_task) {
			const { user } = options.cancel_task.user;
			await cancelTask(user.id);
			globalClient.busyCounterCache.delete(user.id);
			Cooldowns.delete(user.id);
			minionActivityCacheDelete(user.id);
			return 'Done.';
		}
		if (options.sync_roles) {
			try {
				const result = await runRolesTask();
				if (result.length < 2000) return result;
				return {
					content: 'The result was too big! Check the file.',
					files: [new AttachmentBuilder(Buffer.from(result), { name: 'roles.txt' })]
				};
			} catch (err: any) {
				logError(err);
				return `Failed to run roles task. ${err.message}`;
			}
		}
		if (options.sync_patreon) {
			await patreonTask.run();
			syncLinkedAccounts();
			return 'Finished syncing patrons.';
		}
		if (options.add_ironman_alt) {
			const mainAccount = await mahojiUsersSettingsFetch(options.add_ironman_alt.main.user.id, {
				minion_ironman: true,
				id: true,
				ironman_alts: true,
				main_account: true
			});
			const altAccount = await mahojiUsersSettingsFetch(options.add_ironman_alt.ironman_alt.user.id, {
				minion_ironman: true,
				bitfield: true,
				id: true,
				ironman_alts: true,
				main_account: true
			});
			const mainUser = await mUserFetch(mainAccount.id);
			const altUser = await mUserFetch(altAccount.id);
			if (mainAccount === altAccount) return "They're they same account.";
			if (mainAccount.minion_ironman) return `${mainUser.usernameOrMention} is an ironman.`;
			if (!altAccount.minion_ironman) return `${altUser.usernameOrMention} is not an ironman.`;

			const peopleWithThisAltAlready = (
				await prisma.$queryRawUnsafe<unknown[]>(
					`SELECT id FROM users WHERE '${altAccount.id}' = ANY(ironman_alts);`
				)
			).length;
			if (peopleWithThisAltAlready > 0) {
				return `Someone already has ${altUser.usernameOrMention} as an ironman alt.`;
			}
			if (mainAccount.main_account) {
				return `${mainUser.usernameOrMention} has a main account connected already.`;
			}
			if (altAccount.main_account) {
				return `${altUser.usernameOrMention} has a main account connected already.`;
			}
			const mainAccountsAlts = mainAccount.ironman_alts;
			if (mainAccountsAlts.includes(altAccount.id)) {
				return `${mainUser.usernameOrMention} already has ${altUser.usernameOrMention} as an alt.`;
			}

			await handleMahojiConfirmation(
				interaction,
				`Are you sure that \`${altUser.usernameOrMention}\` is the alt account of \`${mainUser.usernameOrMention}\`?`
			);
			await mahojiUserSettingsUpdate(mainAccount.id, {
				ironman_alts: {
					push: altAccount.id
				}
			});
			await mahojiUserSettingsUpdate(altAccount.id, {
				main_account: mainAccount.id
			});
			return `You set \`${altUser.usernameOrMention}\` as the alt account of \`${mainUser.usernameOrMention}\`.`;
		}

		if (options.badges) {
			if ((!options.badges.remove && !options.badges.add) || (options.badges.add && options.badges.remove)) {
				return Object.entries(badges)
					.map(entry => `**${entry[1]}:** ${entry[0]}`)
					.join('\n');
			}
			const badgeInput = options.badges.remove ?? options.badges.add;
			const action: 'add' | 'remove' = !options.badges.remove ? 'add' : 'remove';
			const badge: [string, number] | undefined = Object.entries(BadgesEnum).find(i => i[0] === badgeInput);
			if (!badge) return 'Invalid badge.';
			const [badgeName, badgeID] = badge;

			const userToUpdateBadges = await mahojiUsersSettingsFetch(options.badges.user.user.id, {
				badges: true,
				id: true
			});
			let newBadges = [...userToUpdateBadges.badges];

			if (action === 'add') {
				if (newBadges.includes(badgeID)) return "Already has this badge, so can't add.";
				newBadges.push(badgeID);
			} else {
				if (!newBadges.includes(badgeID)) return "Doesn't have this badge, so can't remove.";
				newBadges = newBadges.filter(i => i !== badgeID);
			}

			await mahojiUserSettingsUpdate(userToUpdateBadges.id, {
				badges: uniqueArr(newBadges)
			});

			return `${action === 'add' ? 'Added' : 'Removed'} ${badgeName} ${badges[badgeID]} badge to ${
				options.badges.user.user.username
			}.`;
		}

		if (options.bypass_age) {
			const input = await mahojiUsersSettingsFetch(options.bypass_age.user.user.id, { bitfield: true, id: true });
			if (input.bitfield.includes(BitField.BypassAgeRestriction)) {
				return 'This user is already bypassed.';
			}
			await mahojiUserSettingsUpdate(input.id, {
				bitfield: {
					push: BitField.BypassAgeRestriction
				}
			});
			return `Bypassed age restriction for ${options.bypass_age.user.user.username}.`;
		}

		if (options.command) {
			const { disable } = options.command;
			const { enable } = options.command;

			const currentDisabledCommands = (await prisma.clientStorage.findFirst({
				where: { id: globalConfig.clientID },
				select: { disabled_commands: true }
			}))!.disabled_commands;

			const command = allAbstractCommands(globalClient.mahojiClient).find(c =>
				stringMatches(c.name, disable ?? enable ?? '-')
			);
			if (!command) return "That's not a valid command.";

			if (disable) {
				if (currentDisabledCommands.includes(command.name)) {
					return 'That command is already disabled.';
				}
				const newDisabled = [...currentDisabledCommands, command.name.toLowerCase()];
				await prisma.clientStorage.update({
					where: {
						id: globalConfig.clientID
					},
					data: {
						disabled_commands: newDisabled
					}
				});
				DISABLED_COMMANDS.add(command.name);
				return `Disabled \`${command.name}\`.`;
			}
			if (enable) {
				if (!currentDisabledCommands.includes(command.name)) {
					return 'That command is not disabled.';
				}
				await prisma.clientStorage.update({
					where: {
						id: globalConfig.clientID
					},
					data: {
						disabled_commands: currentDisabledCommands.filter(i => i !== command.name)
					}
				});
				DISABLED_COMMANDS.delete(command.name);
				return `Enabled \`${command.name}\`.`;
			}
			return 'Invalid.';
		}
		if (options.view_user) {
			const userToView = await mUserFetch(options.view_user.user.user.id);
			return (await getUserInfo(userToView)).everythingString;
		}
		if (options.set_price) {
			const item = getItem(options.set_price.item);
			if (!item) return 'Invalid item.';
			const { price } = options.set_price;
			if (!price || price < 1 || price > 1_000_000_000) return 'Invalid price.';
			await handleMahojiConfirmation(
				interaction,
				`Are you sure you want to set the price of \`${item.name}\`(ID: ${item.id}, Wiki: ${
					item.wiki_url
				}) to \`${price.toLocaleString()}\`?`
			);
			const settings = await mahojiClientSettingsFetch({ custom_prices: true });
			const current = settings.custom_prices as ItemBank;
			const newPrices = { ...current, [item.id]: price };
			await mahojiClientSettingsUpdate({
				custom_prices: newPrices
			});
			await syncCustomPrices();
			return `Set the price of \`${item.name}\` to \`${price.toLocaleString()}\`.`;
		}
		if (options.most_active) {
			const res = await prisma.$queryRawUnsafe<{ num: number; username: string }[]>(`
SELECT sum(duration) as num, "new_user"."username", user_id
FROM activity
INNER JOIN "new_users" "new_user" on "new_user"."id" = "activity"."user_id"::text
WHERE start_date > now() - interval '2 days'
GROUP BY user_id, "new_user"."username"
ORDER BY num DESC
LIMIT 10;
`);
			return `Most Active Users in past 48h\n${res
				.map((i, ind) => `${ind + 1} ${i.username}: ${formatDuration(i.num)}`)
				.join('\n')}`;
		}

		if (options.bitfield) {
			const bitInput = options.bitfield.add ?? options.bitfield.remove;
			const user = await mUserFetch(options.bitfield.user.user.id);
			const bitEntry = Object.entries(BitFieldData).find(i => i[0] === bitInput);
			const action: 'add' | 'remove' = options.bitfield.add ? 'add' : 'remove';
			if (!bitEntry) {
				return Object.entries(BitFieldData)
					.map(entry => `**${entry[0]}:** ${entry[1]?.name}`)
					.join('\n');
			}
			const bit = parseInt(bitEntry[0]);

			if (
				!bit ||
				!(BitFieldData as any)[bit] ||
				[7, 8].includes(bit) ||
				(action !== 'add' && action !== 'remove')
			) {
				return 'Invalid bitfield.';
			}

			let newBits = [...user.bitfield];

			if (action === 'add') {
				if (newBits.includes(bit)) {
					return "Already has this bit, so can't add.";
				}
				newBits.push(bit);
			} else {
				if (!newBits.includes(bit)) {
					return "Doesn't have this bit, so can't remove.";
				}
				newBits = newBits.filter(i => i !== bit);
			}

			await user.update({
				bitfield: uniqueArr(newBits)
			});

			return `${action === 'add' ? 'Added' : 'Removed'} '${(BitFieldData as any)[bit].name}' bit to ${
				options.bitfield.user.user.username
			}.`;
		}
		if (options.reboot) {
			globalClient.isShuttingDown = true;
			await sleep(Time.Second * 20);
			await interactionReply(interaction, {
				content: 'https://media.discordapp.net/attachments/357422607982919680/1004657720722464880/freeze.gif'
			});
			process.exit();
		}
		if (options.viewbank) {
			const userToCheck = await mUserFetch(options.viewbank.user.user.id);
			const bank = userToCheck.allItemsOwned;
			return { files: [(await makeBankImage({ bank, title: userToCheck.usernameOrMention })).file] };
		}

		if (options.sync_blacklist) {
			await syncBlacklists();
			return `Users Blacklisted: ${BLACKLISTED_USERS.size}
Guilds Blacklisted: ${BLACKLISTED_GUILDS.size}`;
		}

		/**
		 *
		 * Admin Only Commands
		 *
		 */
		if (!isOwner && !ADMIN_IDS.includes(userID)) {
			return randArrItem(gifs);
		}

		if (options.sync_commands) {
			const global = Boolean(production);
			const totalCommands = globalClient.mahojiClient.commands.values;
			const globalCommands = totalCommands.filter(i => !i.guildID);
			const guildCommands = totalCommands.filter(i => Boolean(i.guildID));
			if (global) {
				await bulkUpdateCommands({
					client: globalClient.mahojiClient,
					commands: globalCommands,
					guildID: null
				});
				await bulkUpdateCommands({
					client: globalClient.mahojiClient,
					commands: guildCommands,
					guildID: guildID.toString()
				});
			} else {
				await bulkUpdateCommands({
					client: globalClient.mahojiClient,
					commands: totalCommands,
					guildID: guildID.toString()
				});
			}

			// If not in production, remove all global commands.
			if (!production) {
				await bulkUpdateCommands({
					client: globalClient.mahojiClient,
					commands: [],
					guildID: null
				});
			}

			return `Synced commands ${global ? 'globally' : 'locally'}.
${totalCommands.length} Total commands
${globalCommands.length} Global commands
${guildCommands.length} Guild commands`;
		}

		if (options.view) {
			const thing = viewableThings.find(i => i.name === options.view?.thing);
			if (!thing) return 'Invalid';
			const clientSettings = await mahojiClientSettingsFetch();
			const res = await thing.run(clientSettings);
			if (!(res instanceof Bank)) return res;
			const image = await makeBankImage({
				bank: res,
				title: thing.name,
				flags: { sort: thing.name === 'All Equipped Items' ? 'name' : (undefined as any) }
			});
			return { files: [image.file] };
		}

		if (options.give_items) {
			const items = parseBank({ inputStr: options.give_items.items });
			const user = await mUserFetch(options.give_items.user.user.id);
			await handleMahojiConfirmation(
				interaction,
				`Are you sure you want to give ${items} to ${user.usernameOrMention}?`
			);
			await sendToChannelID(Channel.BotLogs, {
				content: `${adminUser.logName} sent \`${items}\` to ${user.logName} for ${
					options.give_items.reason ?? 'No reason'
				}`
			});

			await user.addItemsToBank({ items, collectionLog: false });
			return `Gave ${items} to ${user.mention}`;
		}

		if (options.debug_patreon) {
			const result = await patreonTask.fetchPatrons();
			return {
				files: [{ attachment: Buffer.from(JSON.stringify(result, null, 4)), name: 'patreon.txt' }]
			};
		}

		/**
		 *
		 * Owner Only Commands
		 *
		 */
		if (!isOwner) {
			return randArrItem(gifs);
		}

		if (options.eval) {
			return evalCommand(userID.toString(), options.eval.code);
		}
		if (options.item_stats) {
			const item = getItem(options.item_stats.item);
			if (!item) return 'Invalid item.';
			const isIron = false;
			const ownedResult: any = await prisma.$queryRawUnsafe(`SELECT SUM((bank->>'${item.id}')::int) as qty
FROM users
WHERE bank->>'${item.id}' IS NOT NULL;`);
			return `There are ${ownedResult[0].qty.toLocaleString()} ${item.name} owned by everyone.
There are ${await countUsersWithItemInCl(item.id, isIron)} ${isIron ? 'ironmen' : 'people'} with atleast 1 ${
				item.name
			} in their collection log.`;
		}

		if (options.loot_track) {
			const loot = await prisma.lootTrack.findFirst({
				where: {
					id: options.loot_track.name
				}
			});
			if (!loot) return 'Invalid';

			const durationMillis = loot.total_duration * Time.Minute;

			const arr = [
				['Cost', new Bank(loot.cost as ItemBank)],
				['Loot', new Bank(loot.loot as ItemBank)]
			] as const;

			let content = `${loot.id} ${formatDuration(loot.total_duration * Time.Minute)} KC${loot.total_kc}`;
			const files = [];
			for (const [name, bank] of arr) {
				content += `\n${convertBankToPerHourStats(bank, durationMillis).join(', ')}`;
				files.push((await makeBankImage({ bank, title: name })).file);
			}
			return { content, files };
		}
		if (options.add_patron_time) {
			const { tier, time, user: userToGive } = options.add_patron_time;
			if (![1, 2, 3, 4, 5].includes(tier)) return 'Invalid input.';
			const duration = new Duration(time);
			const ms = duration.offset;
			if (ms < Time.Second || ms > Time.Year * 3) return 'Invalid input.';
			const input = await mahojiUsersSettingsFetch(userToGive.user.id, {
				premium_balance_expiry_date: true,
				id: true,
				premium_balance_tier: true
			});

			const currentBalanceTier = input.premium_balance_tier;

			if (currentBalanceTier !== null && currentBalanceTier !== tier) {
				await handleMahojiConfirmation(
					interaction,
					`They already have Tier ${currentBalanceTier}; this will replace the existing balance entirely, are you sure?`
				);
			}
			await handleMahojiConfirmation(
				interaction,
				`Are you sure you want to add ${formatDuration(ms)} of Tier ${tier} patron to ${
					userToGive.user.username
				}?`
			);
			await mahojiUserSettingsUpdate(input.id, {
				premium_balance_tier: tier
			});

			const currentBalanceTime =
				input.premium_balance_expiry_date === null ? null : Number(input.premium_balance_expiry_date);

			let newBalanceExpiryTime = 0;
			if (currentBalanceTime !== null && tier === currentBalanceTier) {
				newBalanceExpiryTime = currentBalanceTime + ms;
			} else {
				newBalanceExpiryTime = Date.now() + ms;
			}
			await mahojiUserSettingsUpdate(input.id, {
				premium_balance_expiry_date: newBalanceExpiryTime
			});

			return `Gave ${formatDuration(ms)} of Tier ${tier} patron to ${
				userToGive.user.username
			}. They have ${formatDuration(newBalanceExpiryTime - Date.now())} remaining.`;
		}
		if (options.double_loot) {
			if (options.double_loot.reset) {
				await mahojiClientSettingsUpdate({
					double_loot_finish_time: 0
				});
				return 'Reset the double loot timer.';
			}
			if (options.double_loot.add) {
				const duration = new Duration(options.double_loot.add);
				const ms = duration.offset;
				await handleMahojiConfirmation(interaction, `Add ${formatDuration(ms)} to double loot timer?`);
				addToDoubleLootTimer(ms, 'added by RP command');
				return `Added ${formatDuration(ms)} to the double loot timer.`;
			}
		}
		if (options.ltc) {
			let str = '';
			const results = await prisma.lootTrack.findMany();

			if (options.ltc.item) {
				str += `${['id', 'total_of_item', 'item_per_kc', 'per_hour'].join('\t')}\n`;
				const item = getOSItem(options.ltc.item);

				for (const res of results) {
					const loot = new Bank(res.loot as ItemBank);
					if (!loot.has(item.id)) continue;
					const qty = loot.amount(item.id);
					str += `${[
						res.id,
						qty,
						qty / res.total_kc,
						calcPerHour(qty, res.total_duration * Time.Minute)
					].join('\t')}\n`;
				}

				return {
					files: [{ attachment: Buffer.from(str), name: `${cleanString(item.name)}.txt` }]
				};
			}

			str += `${['id', 'cost_h', 'cost', 'loot_h', 'loot', 'per_hour_h', 'per_hour', 'ratio'].join('\t')}\n`;
			for (const res of results) {
				if (!res.total_duration || !res.total_kc) continue;
				if (Object.keys({ ...(res.cost as ItemBank), ...(res.loot as ItemBank) }).length === 0) continue;
				const cost = new Bank(res.cost as ItemBank);
				const loot = new Bank(res.loot as ItemBank);
				sanitizeBank(cost);
				sanitizeBank(loot);
				const marketValueCost = Math.round(cost.value());
				const marketValueLoot = Math.round(loot.value());
				const ratio = marketValueLoot / marketValueCost;

				if (!marketValueCost || !marketValueLoot || ratio === Infinity) continue;

				str += `${[
					res.id,
					toKMB(marketValueCost),
					marketValueCost,
					toKMB(marketValueLoot),
					marketValueLoot,
					toKMB(calcPerHour(marketValueLoot, res.total_duration * Time.Minute)),
					calcPerHour(marketValueLoot, res.total_duration * Time.Minute),
					ratio
				].join('\t')}\n`;
			}

			return {
				files: [{ attachment: Buffer.from(str), name: 'output.txt' }]
			};
		}

		// if (options.lottery_dump) {
		// 	const res = await getLotteryBank();
		// 	for (const user of res.users) {
		// 		if (!globalClient.users.cache.has(user.id)) {
		// 			await globalClient.users.fetch(user.id);
		// 		}
		// 	}
		// 	return {
		// 		files: [
		// 			{
		// 				name: 'lottery.txt',
		// 				attachment: Buffer.from(
		// 					JSON.stringify(
		// 						res.users.map(i => [globalClient.users.cache.get(i.id)?.username ?? i.id, i.tickets])
		// 					)
		// 				)
		// 			}
		// 		]
		// 	};
		// }

		if (options.box_frenzy) {
			boxFrenzy(channelID, 'Box Frenzy started!', options.box_frenzy.amount);
			return null;
		}

		return 'Invalid command.';
	}
};

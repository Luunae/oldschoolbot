import './lib/safeglobals';
import './lib/globals';
import './lib/MUser';
import './lib/util/transactItemsFromBank';

import { MahojiClient, bulkUpdateCommands } from '@oldschoolgg/toolkit';
import type { TextChannel } from 'discord.js';
import { GatewayIntentBits, Options, Partials } from 'discord.js';
import { isObject } from 'e';

import { BLACKLISTED_GUILDS, BLACKLISTED_USERS } from './lib/blacklists';
import { Events, globalConfig } from './lib/constants';
import { onMessage } from './lib/events';
import { modalInteractionHook } from './lib/modals';
import { preStartup } from './lib/preStartup';
import { OldSchoolBotClient } from './lib/structures/OldSchoolBotClient';
import { runTimedLoggedFn } from './lib/util';
import { interactionHook } from './lib/util/globalInteractions';
import { handleInteractionError, interactionReply } from './lib/util/interactionReply';
import { logError } from './lib/util/logError';
import { allCommands } from './mahoji/commands/allCommands';
import { onStartup } from './mahoji/lib/events';
import { postCommand } from './mahoji/lib/postCommand';
import { preCommand } from './mahoji/lib/preCommand';
import { convertMahojiCommandToAbstractCommand } from './mahoji/lib/util';

const client = new OldSchoolBotClient({
	shards: 'auto',
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.GuildMessageReactions,
		GatewayIntentBits.DirectMessages,
		GatewayIntentBits.DirectMessageReactions,
		GatewayIntentBits.GuildWebhooks
	],
	partials: [Partials.User, Partials.Channel],
	allowedMentions: {
		parse: ['users']
	},
	makeCache: Options.cacheWithLimits({
		MessageManager: {
			maxSize: 0
		},
		UserManager: {
			maxSize: 1000
		},
		GuildMemberManager: {
			maxSize: 200
		},
		GuildEmojiManager: {
			maxSize: 1
		},
		GuildStickerManager: { maxSize: 0 },
		PresenceManager: { maxSize: 0 },
		VoiceStateManager: { maxSize: 0 },
		GuildInviteManager: { maxSize: 0 },
		ThreadManager: { maxSize: 0 },
		ThreadMemberManager: { maxSize: 0 }
	})
});

export const mahojiClient = new MahojiClient({
	developmentServerID: globalConfig.mainServerID,
	applicationID: globalConfig.clientID,
	commands: allCommands,
	handlers: {
		preCommand: async ({ command, interaction, options }) => {
			const result = await preCommand({
				abstractCommand: convertMahojiCommandToAbstractCommand(command),
				userID: interaction.user.id,
				guildID: interaction.guildId,
				channelID: interaction.channelId,
				bypassInhibitors: false,
				apiUser: interaction.user,
				options
			});
			return result;
		},
		postCommand: ({ command, interaction, error, inhibited, options }) =>
			postCommand({
				abstractCommand: convertMahojiCommandToAbstractCommand(command),
				userID: interaction.user.id,
				guildID: interaction.guildId,
				channelID: interaction.channelId,
				args: options,
				error,
				isContinue: false,
				inhibited,
				continueDeltaMillis: null
			})
	},
	djsClient: client
});

declare global {
	var globalClient: OldSchoolBotClient;
}

client.mahojiClient = mahojiClient;
global.globalClient = client;
client.on('messageCreate', msg => {
	onMessage(msg);
});
client.on('error', console.error);
client.on('interactionCreate', async interaction => {
	if (globalClient.isShuttingDown) {
		if (interaction.isRepliable()) {
			await interactionReply(interaction, {
				content:
					'Randomizer is currently shutting down for maintenance/updates, please try again in a couple minutes! Thank you <3',
				ephemeral: true
			});
		}
		return;
	}

	if (
		BLACKLISTED_USERS.has(interaction.user.id) ||
		(interaction.guildId && BLACKLISTED_GUILDS.has(interaction.guildId))
	) {
		if (interaction.isRepliable()) {
			await interactionReply(interaction, {
				content: 'You are blacklisted.',
				ephemeral: true
			});
		}
		return;
	}

	try {
		await interactionHook(interaction);
		if (interaction.isModalSubmit()) {
			await modalInteractionHook(interaction);
			return;
		}

		const result = await mahojiClient.parseInteraction(interaction);
		if (result === null) return;
		if (isObject(result) && 'error' in result) {
			await handleInteractionError(result.error, interaction);
		}
	} catch (err) {
		await handleInteractionError(err, interaction);
	}
});

client.on(Events.ServerNotification, (message: string) => {
	const channel = globalClient.channels.cache.get(globalConfig.announcementsChannelID);
	if (channel) (channel as TextChannel).send(message);
});

client.on('guildCreate', guild => {
	if (!guild.available) return;
	if (BLACKLISTED_GUILDS.has(guild.id) || BLACKLISTED_USERS.has(guild.ownerId)) {
		guild.leave();
	}
});

client.on('shardError', err => debugLog('Shard Error', { error: err.message }));

async function main() {
	if (process.env.TEST) return;
	await preStartup();
	await runTimedLoggedFn('Log In', () => client.login(globalConfig.botToken));
	console.log(`Logged in as ${globalClient.user.username}`);
	const totalCommands = Array.from(globalClient.mahojiClient.commands.values());
	const globalCommands = totalCommands.filter(i => !i.guildID);
	const guildCommands = totalCommands.filter(i => Boolean(i.guildID) && !['testpotato'].includes(i.name));
	if (globalConfig.isProduction) {
		await bulkUpdateCommands({
			client: globalClient.mahojiClient,
			commands: globalCommands,
			guildID: null
		});
	}
	await bulkUpdateCommands({
		client: globalClient.mahojiClient,
		commands: guildCommands,
		guildID: globalConfig.isProduction ? '342983479501389826' : '940758552425955348'
	});
	await onStartup();
}

process.on('uncaughtException', err => {
	console.error(err);
	logError(err);
});

process.on('unhandledRejection', err => {
	console.error(err);
	logError(err);
});

main();

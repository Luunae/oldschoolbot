import { CommandStore, KlasaMessage, KlasaUser } from 'klasa';

import { BotCommand } from '../../lib/BotCommand';
import { Time, Activity, Tasks } from '../../lib/constants';
import { formatDuration, rand } from '../../lib/util';
import { UserSettings } from '../../lib/settings/types/UserSettings';
import { TitheFarmActivityTaskOptions } from '../../lib/types/minions';
import { minionNotBusy, requiresMinion } from '../../lib/minions/decorators';
import { SkillsEnum } from '../../lib/skilling/types';
import { MinigameIDsEnum } from '../../lib/minions/data/minigames';
import addSubTaskToActivityTask from '../../lib/util/addSubTaskToActivityTask';
import hasGracefulEquipped from '../../lib/gear/functions/hasGracefulEquipped';

export default class extends BotCommand {
	public constructor(store: CommandStore, file: string[], directory: string) {
		super(store, file, directory, {
			oneAtTime: true,
			altProtection: true
		});
	}

	determineDuration(user: KlasaUser): [number, string[]] {
		let baseTime = Time.Second * 1538;
		let nonGracefulTimeAddition = Time.Second * 123;

		const boostStr = [];

		// Reduce time based on tithe farm completions
		const titheFarmStats = user.settings.get(UserSettings.Stats.TitheFarmStats);
		const { titheFarmsCompleted } = titheFarmStats;
		const percentIncreaseFromCompletions =
			Math.floor(Math.min(60, titheFarmsCompleted) / 3) / 100;
		baseTime = Math.floor(baseTime * (1 - percentIncreaseFromCompletions));
		boostStr.push(
			`**Boosts**: ${Math.floor(
				percentIncreaseFromCompletions * 100
			)}% from Tithe Farms completed`
		);

		// Reduce time if user has graceful equipped
		if (hasGracefulEquipped(user.settings.get(UserSettings.Gear.Skilling))) {
			nonGracefulTimeAddition = 0;
			boostStr.push('10% from graceful outfit');
		}

		const totalTime = baseTime + nonGracefulTimeAddition;

		return [totalTime, boostStr];
	}

	@minionNotBusy
	@requiresMinion
	async run(msg: KlasaMessage) {
		await msg.author.settings.sync(true);
		const titheFarmStats = msg.author.settings.get(UserSettings.Stats.TitheFarmStats);
		const { titheFarmPoints } = titheFarmStats;

		if (msg.flagArgs.points) {
			return msg.send(`You have ${titheFarmPoints} Tithe Farm points.`);
		}

		if (msg.author.skillLevel(SkillsEnum.Farming) < 34) {
			throw `${msg.author.minionName} needs 34 Farming to use the Tithe Farm!`;
		}

		const [duration, boostStr] = this.determineDuration(msg.author);

		const data: TitheFarmActivityTaskOptions = {
			minigameID: MinigameIDsEnum.TitheFarm,
			userID: msg.author.id,
			channelID: msg.channel.id,
			quantity: 1,
			duration,
			type: Activity.TitheFarm,
			id: rand(1, 10_000_000),
			finishDate: Date.now() + duration
		};

		await addSubTaskToActivityTask(this.client, Tasks.MinigameTicker, data);

		return msg.send(
			`Your minion is off completing a round of the Tithe Farm. It'll take ${formatDuration(
				duration
			)} to finish.\n\n${boostStr.join(', ')}`
		);
	}
}

import { readdir, readFile, writeFile } from "fs/promises";
import { join as joinPaths } from "path";
import { EventEmitter } from "events";
import {
    Gamemode,
    RequestHandler,
    RequestType,
    ScoreType
} from "ramune";
import type { Score } from "ramune/lib/Responses";
import { MessageEmbedOptions } from "slash-create";

import { Blob } from "../Blob";
import { Collection } from "../Utils/Collection";
import { ConfigStore } from "./Stores/ConfigStore";
import { DailiesStore, DailiesMap } from "./Stores/DailiesStore";
import { asyncMap, capitalise } from "../Utils/Helpers";
import { Component, Load, Dependency } from "../Utils/DependencyInjection";
import { Logger } from "../Utils/Logger";
import { WrappedRamune } from "./WrappedRamune";
import { DiscordClient } from "./Discord";

export interface TrackerEvents<T> {
    (event: "newScore", listener: (score: Score) => void): T;
}
export interface DailiesTracker {
    on: TrackerEvents<this>;
    once: TrackerEvents<this>;
}
@Component("Tracker/Dailies")
export class DailiesTracker extends EventEmitter implements Component {
    private readonly logger = new Logger("Tracker/Dailies");

    @Dependency private readonly config!: ConfigStore;
    @Dependency private readonly dailiesStore!: DailiesStore;
    @Dependency private readonly discord!: DiscordClient;
    @Dependency private readonly ramune!: WrappedRamune;

    private trackTimer?: NodeJS.Timeout;
    private readonly requestHandler = new RequestHandler({
        defaultHost: "discord.com",
        rateLimit: {
            limit: 5,
            interval: 5e3
        }
    });
    private readonly webhook = {
        id: Blob.Environment.webhookID,
        token: Blob.Environment.webhookToken
    };

    private recording: boolean;

    /**
     * This collection is used to track all scores; it stores all recent plays of a user
     * and used to detect new recent plays
     * format: Collection<PlayerID, ScoreID>
     */
    private readonly allScores: Collection<number, number[]>;
    /**
     * This collection is used to track the user's top scores per map.
     * format: Collection<MapID, Collection<PlayerID, Score>>
     */
    private readonly scores: Collection<number, Collection<number, Score>>;

    constructor() {
        super();
        this.allScores = new Collection();
        this.scores = new Collection();
        this.recording = true;
    }

    @Load
    async load() {
        if (this.trackTimer)
            clearInterval(this.trackTimer);

        this.trackTimer = setInterval(this.refresh.bind(this), 60e3);
        this.dailiesStore.on("mapReset", this.newMap.bind(this));
        await this.replayScores();
        await this.updateScores();
    }

    public getScore(map: number, player: number) {
        return this.scores.get(map)?.get(player);
    }
    public getMapScores(map: number) {
        return this.scores.get(map);
    }
    public getScores() {
        return this.scores;
    }

    public async replayScores() {
        const scorePaths = await readdir(Blob.Environment.scorePath);
        const scores = await asyncMap(scorePaths, async scoreName =>
            JSON.parse(await readFile(joinPaths(Blob.Environment.scorePath, scoreName), "utf8")) as Score
        );

        /* we're not running this in parallel since we want later scores
         * to override earlier ones, and this could introduce nasty race
         * conditions
         */
        for (const score of scores)
            await this.process(score, false, false);

        return;
    }

    private async updateScores() {
        this.logger.info("Checking for lost scores");
        const lostScores: Score[] = [];
        await this.dailiesStore.getPlayers().asyncMap(async player => {
            const plays = this.allScores.getOrSet(player.id, []);
            const cursor = this.ramune.getUserScores(player.id, ScoreType.Recent, Gamemode.Osu);
            for await (const score of cursor.iterate(10)) {
                if (plays.includes(score.id))
                    break;

                lostScores.push(score);
            }
        });
        if (!lostScores.length) {
            this.logger.info("No scores to recover");
            return;
        }
        this.logger.info(`Recovering ${lostScores.length} lost scores`);

        for (const score of lostScores)
            await this.process(score);
    }

    private async refresh() {
        const res = await this.dailiesStore.getPlayers().asyncMap(async player => await this.refreshPlayer(player.id, false));
        const scores = res
            .flat(1)
            .sort((a, b) => a.id - b.id);

        await Promise.all(scores.map(async score => await this.process(score)));
    }

    protected async newMap(map?: DailiesMap) {
        if (map === undefined)
            return;

        if (map.messageID !== undefined)
            return;

        const channelID = this.dailiesStore.motdChannel;
        if (channelID === undefined)
            return;

        const beatmap = map.map;
        const beatmapset = map.beatmapset;
        const msg = await this.discord.createMessage(channelID, { embed: {
            title: `${beatmapset.artist} - ${beatmapset.title} [${beatmap.version}]`,
            description: `Ending <t:${Math.floor(map.timeRange[1] / 1000)}:R>`,
            url: `https://osu.ppy.sh/b/${beatmap.id}`,
            thumbnail: { url: `https://b.ppy.sh/thumb/${beatmapset.id}l.jpg` },
            timestamp: new Date(map.timeRange[0]),
            color: 0x00FF00,
            fields: [
                {
                    name: "Beatmap Info",
                    inline: false,
                    value: [
                        `Status: **${capitalise(beatmap.status)}**`,
                        `Mapper: **${beatmapset.creator}**`,
                        `Required Mods: **${this.dailiesStore.getFriendlyMods(beatmap.id)}**`,
                        `Max Combo: **${beatmap.maxCombo ?? "Unknown"}**`,
                        `Star Rating: **${beatmap.starRating}**`,
                        `CS/AR/OD/HP: **${beatmap.cs.toFixed(1)}**/**${beatmap.ar.toFixed(1)}**/**${beatmap.accuracy.toFixed(1)}**/**${beatmap.drain.toFixed(1)}**`
                    ].join("\n")
                },
                {
                    name: "Scores",
                    inline: false,
                    value: ""
                }
            ]
        } });

        map.messageID = msg.id;
        await this.dailiesStore.sync();
    }

    public async refreshPlayer(player: number, shouldProcess: boolean = true) {
        const scores: Score[] = [];
        const playerScores = this.allScores.getOrSet(player, []);

        try {
            const cursor = this.ramune.getUserScores(player.toString(), ScoreType.Recent, Gamemode.Osu);
            for await (const score of cursor.iterate(5)) {
                if (playerScores.includes(score.id))
                    break;

                scores.push(score);
            }
        } catch(e) {
            this.logger.error("Error getting user scores", player, e);
            return [];
        }

        playerScores.push(...scores.map(i => i.id));

        if (shouldProcess)
            await asyncMap(scores, async score => await this.process(score));

        return scores;
    }

    public async process(score: Score, shouldPost: boolean = true, shouldStore: boolean = true) {
        this.emit("newScore", score);

        this.allScores.getOrSet(score.user_id, []).push(score.id);
        if (this.recording && shouldStore)
            await writeFile(joinPaths(Blob.Environment.scorePath, `${score.id}.json`), JSON.stringify(score, undefined, 4));

        // Check 1: Is the map the current map?
        const map = this.dailiesStore.currentMap;
        if (map?.map.id !== score.beatmap!.id)
            return;

        // Check 2: Is this score higher than the previous score?
        const scores = this.scores.getOrSet(score.beatmap!.id, new Collection());
        const previousScore = scores.get(score.user_id);
        if (previousScore && previousScore.score > score.score)
            return;

        // Check 3: Does the score have the necessary mods?
        if (!this.dailiesStore.testMods(map.map.id, score.mods))
            return;

        scores.set(score.user_id, score);

        if (shouldPost) {
            this.logger.info(`Processing: ${score.id} - ${score.best_id}`);
            await this.post(map, score);
        }
        return;
    }

    private async post(map: DailiesMap, score: Score) {
        const beatmap = map.map;
        const beatmapset = map.beatmapset;
        const user = score.user!;

        const embed: MessageEmbedOptions = {
            author: {
                name: `${beatmapset.artist} - ${beatmapset.title} [${beatmap.version}]` + (score.mods.length ? " +" + score.mods.join("") : ""),
                url: `https://osu.ppy.sh/b/${beatmap.id}`
            },
            thumbnail: { url: `https://b.ppy.sh/thumb/${beatmapset.id}l.jpg` },
            color: 0x33EB35,
            description: [
                `Map #${map.index + 1}`,
                map.requester ? `Requester = ${map.requester}` : undefined,
                `Map ID = ${beatmap.id}`,
                `Required Mods = ${this.dailiesStore.getFriendlyMods(beatmap.id)}`
            ].filter(i => i !== undefined).join("\n"),
            fields: [
                {
                    name: "Score Info",
                    value: [
                        `Score: **${score.score.toLocaleString()}**${score.mods.length ? ` **+${score.mods.join("")}**` : ""}`,
                        `Accuracy: **${Math.round(score.accuracy * 10000) / 100}%**`,
                        `Rank: ${this.config.getRankEmote(score.rank)!} - ${score.statistics.count_300}/${score.statistics.count_100}/${score.statistics.count_50}/${score.statistics.count_miss}`,
                        `Combo: **${score.max_combo}**/${map.map.maxCombo?.toString() ?? "0"}x`,
                        score.best_id ? `[View on osu](https://osu.ppy.sh/scores/osu/${score.best_id})` : undefined
                    ].filter(i => i !== undefined).join("\n")
                }
                // TODO
                // {
                //     name: "Ranking Changes",
                //     value: "None (placeholder)"
                // }
            ],
            timestamp: new Date(score.created_at)
        };
        await this.requestHandler.request({
            discardOutput: true,
            endpoint: `/api/webhooks/${this.webhook.id}/${this.webhook.token}`,
            type: RequestType.POST,
            body: {
                username: score.user!.username,
                avatar_url: `https://s.ppy.sh/a/${user.id}`,
                embeds: [embed]
            }
        });
        await this.updateMapScores();
    }

    protected async updateMapScores() {
        const map = this.dailiesStore.currentMap;
        if (map?.messageID === undefined)
            return;

        const channelID = this.dailiesStore.motdChannel;
        if (channelID === undefined)
            return;

        const msg = await this.discord.getMessage(channelID, map.messageID);
        const embed = msg.embeds[0];

        const scores = this.scores.get(map.map.id);
        if (!scores)
            return;

        const desc = scores.map((score, osuID, index) =>
            `${index + 1}. <@${this.dailiesStore.getDiscordFromOsu(osuID)!}> - **${score.score.toLocaleString()}${score.mods.length ? " +" + score.mods.join("") : ""}** at <t:${Math.ceil(new Date(score.created_at).getTime() / 1000)}:t>`
        );

        embed.fields![1].value = desc.join("\n");
        await msg.edit({ embed });
    }


    public toggleRecord(): boolean {
        return this.recording = !this.recording;
    }
}
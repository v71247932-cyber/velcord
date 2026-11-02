import { useEffect, useMemo, useRef } from 'react';
import type { BotCommands } from '../api';
import Avatar from './Avatar';
import './slashMenu.css';

export interface SlashItem {
    bot: BotCommands;
    name: string;
    description: string;
}

const USED_KEY = 'velcord-slash-used';

function readUsed(): Record<string, number> {
    try { return JSON.parse(localStorage.getItem(USED_KEY) || '{}'); } catch { return {}; }
}

export function rememberCommand(name: string) {
    try {
        const used = readUsed();
        used[name] = (used[name] || 0) + 1;
        localStorage.setItem(USED_KEY, JSON.stringify(used));
    } catch { /* noop */ }
}

/** the commands that match what is typed after the slash, grouped like in the list: frequently used first, then each bot */
export function slashItems(bots: BotCommands[], typed: string): { frequent: SlashItem[]; perBot: { bot: BotCommands; items: SlashItem[] }[]; flat: SlashItem[] } {
    const q = typed.toLowerCase();
    const all: SlashItem[] = bots.flatMap(bot => bot.commands.map(c => ({ bot, name: c.name, description: c.description })));
    const match = (i: SlashItem) => !q || i.name.toLowerCase().startsWith(q);
    const used = readUsed();
    const frequent = q ? [] : all.filter(i => used[i.name]).sort((a, b) => used[b.name] - used[a.name]).slice(0, 3);
    const perBot = bots
        .map(bot => ({ bot, items: all.filter(i => i.bot.id === bot.id && match(i)) }))
        .filter(g => g.items.length > 0);
    const flat = [...frequent, ...perBot.flatMap(g => g.items)];
    return { frequent, perBot, flat };
}

interface Props {
    bots: BotCommands[];
    typed: string;
    active: number;
    onPick: (item: SlashItem) => void;
    onHover: (index: number) => void;
}

export default function SlashMenu({ bots, typed, active, onPick, onHover }: Props) {
    const { frequent, perBot } = useMemo(() => slashItems(bots, typed), [bots, typed]);
    const activeRef = useRef<HTMLButtonElement>(null);
    useEffect(() => { activeRef.current?.scrollIntoView({ block: 'nearest' }); }, [active]);

    let index = -1;
    const row = (item: SlashItem, key: string) => {
        index += 1;
        const i = index;
        return (
            <button
                key={key}
                type="button"
                ref={i === active ? activeRef : undefined}
                className={`slash-row ${i === active ? 'active' : ''}`}
                onMouseEnter={() => onHover(i)}
                onMouseDown={e => { e.preventDefault(); onPick(item); }}
            >
                <span className="slash-text">
                    <span className="slash-name">/{item.name}</span>
                    <span className="slash-desc">{item.description}</span>
                </span>
                <span className="slash-bot">{item.bot.username}</span>
            </button>
        );
    };

    if (frequent.length === 0 && perBot.length === 0) return null;
    return (
        <div className="slash-menu" role="listbox" aria-label="Bot commands">
            {frequent.length > 0 && (
                <>
                    <div className="slash-head"><span className="slash-clock">◷</span> Frequently Used</div>
                    {frequent.map(item => row(item, 'f-' + item.name))}
                </>
            )}
            {perBot.map(g => (
                <div key={g.bot.id}>
                    <div className="slash-head">
                        <Avatar name={g.bot.username} color={g.bot.avatarColor} src={g.bot.avatarUrl ?? undefined} size="sm" />
                        <span>{g.bot.username}</span>
                    </div>
                    {g.items.map(item => row(item, g.bot.id + '-' + item.name))}
                </div>
            ))}
        </div>
    );
}

/** The command that is written at the start of the text (after the space that follows its name), if some bot has it */
export function activeCommand(bots: BotCommands[], input: string): SlashItem | null {
    const m = /^\/([a-z0-9_-]+)\s/i.exec(input);
    if (!m) return null;
    const name = m[1].toLowerCase();
    for (const bot of bots) {
        const c = bot.commands.find(x => x.name.toLowerCase() === name);
        if (c) return { bot, name: c.name, description: c.description };
    }
    return null;
}

/** Shown above the text box once a command is chosen: its name and description, and the bot with how many options the command has. */
export function CommandCard({ bots, command, onClear }: { bots: BotCommands[]; command: SlashItem; onClear: () => void }) {
    const full = bots.flatMap(b => b.commands.map(c => ({ bot: b, c }))).find(x => x.bot.id === command.bot.id && x.c.name === command.name);
    const options = full?.c.options || [];
    return (
        <div className="slash-card">
            <div className="slash-card-top">
                <span className="slash-card-name">/{command.name}</span>
                <span className="slash-card-desc">{command.description}</span>
                <button type="button" className="slash-card-x" onClick={onClear} aria-label="Remove the command" title="Remove the command">×</button>
            </div>
            <div className="slash-card-row">
                <Avatar name={command.bot.username} color={command.bot.avatarColor} src={command.bot.avatarUrl ?? undefined} size="sm" />
                <span className="slash-card-name">/{command.name}</span>
                {options.length > 0 && <span className="slash-card-opt">+{options.length} option{options.length === 1 ? '' : 's'}</span>}
                {options.length > 0 && <span className="slash-card-optdesc">{options.map(o => o.name).join(', ')}</span>}
            </div>
        </div>
    );
}

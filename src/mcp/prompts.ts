/**
 * Jambavan MCP prompts.
 *
 * The counsel protocols (root cause, verification, planning, decomposition,
 * dev rules) are static text: they read no file, touch no index, and depend on
 * no project root. Advertising them as tools charged every host request ~2k
 * tokens of schema for text that never changes.
 *
 * MCP has a primitive for exactly this. As prompts they cost nothing until a
 * user invokes one, and they show up as slash commands in hosts that support
 * them. Every name is also still dispatchable as a hidden tool (see
 * tool-aliases.ts) so a model told to call `root_cause` mid-session still can.
 */

import type { Prompt } from '@modelcontextprotocol/sdk/types.js';
import { moolKaaranProtocol } from '../tools/mool-kaaran';
import { pramanProtocol } from '../tools/praman';
import { yuktiProtocol } from '../tools/yukti';
import { vibhaajanProtocol } from '../tools/vibhaajan';
import { vibhishanaNitiInstructions } from '../tools/vibhishana-niti';

export interface PromptDef {
  prompt: Prompt;
  /** Canonical hidden-tool name that produces the same text. */
  tool: string;
  render(args: Record<string, string>): string;
}

export const PROMPT_DEFS: PromptDef[] = [
  {
    tool: 'jambavan_root_cause',
    prompt: {
      name: 'root_cause',
      description:
        'Root-cause investigation protocol. Use before fixing any bug, test failure, or unexpected behavior — it enforces observe → compare → hypothesize → fix instead of guess-and-check. Escalates at 3+ failed attempts.',
      arguments: [
        { name: 'symptom', description: 'The error, unexpected behavior, or test failure.', required: true },
        { name: 'context', description: 'File paths, recent changes, what you were doing.', required: false },
        { name: 'attempts_so_far', description: 'How many fix attempts already failed.', required: false },
      ],
    },
    render: args => moolKaaranProtocol(args),
  },
  {
    tool: 'jambavan_verify_gate',
    prompt: {
      name: 'verify_gate',
      description:
        'Verification gate demanding fresh evidence before claiming completion. Use before asserting tests pass, a build succeeds, a bug is fixed, or requirements are met.',
      arguments: [
        { name: 'claim', description: 'What you are about to assert is done or passing.', required: true },
        { name: 'type', description: 'tests | build | fix | requirements | general.', required: false },
      ],
    },
    render: args => pramanProtocol(args),
  },
  {
    tool: 'jambavan_strategy_plan',
    prompt: {
      name: 'strategy_plan',
      description:
        'Strategic approach protocol for multi-step work, scaled to task size. Use before starting any non-trivial implementation.',
      arguments: [
        { name: 'task', description: 'What you need to accomplish.', required: true },
        { name: 'constraints', description: 'Time, compatibility, dependency, or scope limits.', required: false },
        { name: 'scale', description: 'small | medium | large. Auto-inferred when omitted.', required: false },
      ],
    },
    render: args => yuktiProtocol(args),
  },
  {
    tool: 'jambavan_decompose_task',
    prompt: {
      name: 'decompose_task',
      description:
        'Parallel work decomposition protocol: boundaries, independence checks, contracts, and merge sequencing. Use when a task has sub-units that can proceed independently.',
      arguments: [
        { name: 'task', description: 'What you need to split into parallel units.', required: true },
        { name: 'units', description: 'Target number of parallel units.', required: false },
        { name: 'constraints', description: 'Shared state, file overlap, ordering requirements.', required: false },
      ],
    },
    render: args => vibhaajanProtocol(args),
  },
  {
    tool: 'jambavan_dev_rules',
    prompt: {
      name: 'dev_rules',
      description:
        'Vibhishana Niti: efficient, truthful senior-dev rules — YAGNI first, stdlib before dependencies, shortest working diff, root-cause fixes.',
      arguments: [
        { name: 'mode', description: 'lite | full | ultra. Defaults to full.', required: false },
      ],
    },
    render: args => vibhishanaNitiInstructions(args['mode']),
  },
];

export const PROMPTS: Prompt[] = PROMPT_DEFS.map(def => def.prompt);

export function getPrompt(name: string): PromptDef | undefined {
  return PROMPT_DEFS.find(def => def.prompt.name === name);
}

/** Canonical hidden-tool name for each prompt, used by the tool dispatcher. */
export const PROMPT_TOOL_HANDLERS: Record<string, (input: Record<string, unknown>) => string> = {
  jambavan_root_cause:     input => moolKaaranProtocol(input),
  jambavan_verify_gate:    input => pramanProtocol(input),
  jambavan_strategy_plan:  input => yuktiProtocol(input),
  jambavan_decompose_task: input => vibhaajanProtocol(input),
  jambavan_dev_rules:      input => vibhishanaNitiInstructions(input['mode'] as string | undefined),
};

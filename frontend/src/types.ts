export type ProviderMode = "openai-compatible" | "custom-json" | "mock";

export interface ProviderConfig {
  mode: ProviderMode;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface Race {
  id: string;
  name: string;
  initial_points: number;
  growth: Record<string, number>;
  talent: {
    name: string;
    description: string;
    effects?: string[];
  };
}

export interface Talent {
  id: string;
  name: string;
  description: string;
}

export interface Rules {
  stats: string[];
  statDescriptions?: Record<string, { name: string; description: string }>;
  races: Race[];
  mainTalents: Talent[];
  subTalents: Talent[];
}

export interface Hero {
  id: string;
  name: string;
  race: {
    id: string;
    name: string;
  };
  level: number;
  exp: number;
  reputation?: string;
  stats: Record<string, number>;
  status?: string[];
}

export interface Ability {
  name: string;
  type?: string;
  description?: string;
  level?: number;
}

export interface NpcCard {
  id?: string;
  name: string;
  faction?: string;
  stance?: string;
  relationship?: string;
  affinity?: string | number;
  trust?: string | number;
  goal?: string;
  mental_state?: string;
}

export interface TurnOption {
  id: string;
  title: string;
  description: string;
}

export interface LastTurn {
  scene?: string;
  reactions?: string[];
  hero_status?: string;
  npc_cards?: NpcCard[];
  world_status?: string;
  options?: TurnOption[];
  log?: string[];
}

export interface HistoryEntry {
  turn: number;
  title?: string;
  text?: string;
}

export interface WorldState {
  day?: number;
  location?: string;
  time?: string;
  active_events?: string[];
}

export interface GameState {
  phase: "creation" | "adventure";
  turn: number;
  hero: Hero | null;
  abilities?: Ability[];
  inventory?: Array<{ name?: string } | string>;
  npcs?: NpcCard[];
  world?: WorldState;
  lastTurn?: LastTurn;
  history?: HistoryEntry[];
}

export interface SessionSummary {
  summary: string;
  coveredMessageCount?: number;
}

export interface AgentDefinition {
  id: string;
  name: string;
  role: string;
  responsibilities: string[];
}

export interface AgentContract {
  agents: AgentDefinition[];
}

export interface GrowthProposal {
  id: string;
  type: string;
  title: string;
  rationale: string;
  risk: string;
  status: "pending" | "accepted" | "rejected";
  patchFile?: string | null;
}

export interface BootstrapResponse {
  state: GameState;
  rules: Rules;
  loreCount: number;
  growthDue: boolean;
  sessionSummary: SessionSummary;
  agentContract: AgentContract;
}

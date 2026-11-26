export type Role =
  | 'VILLAGER'
  | 'WEREWOLF'
  | 'SEER'
  | 'BODYGUARD'
  | 'WITCH'
  | 'HUNTER';

export type VisibleRole = Role | 'UNKNOWN';

export type Faction = 'VILLAGER' | 'WEREWOLF';

export type GamePhase =
  | 'LOBBY'
  | 'NIGHT'
  | 'MORNING'
  | 'DISCUSSION'
  | 'VOTING'
  | 'HUNTER_SHOOT'
  | 'GAME_OVER';

export type NightActionType =
  | 'KILL'
  | 'PROTECT'
  | 'SEER'
  | 'WITCH_SAVE'
  | 'WITCH_POISON';

export type ChatChannel = 'PUBLIC' | 'WOLF' | 'DEAD';

export type ErrorCode =
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'GAME_ALREADY_STARTED'
  | 'NOT_HOST'
  | 'INVALID_SETTINGS'
  | 'INVALID_ACTION'
  | 'PLAYER_NOT_FOUND'
  | 'PLAYER_DEAD'
  | 'UNAUTHORIZED_CHANNEL'
  | 'NAME_TAKEN'
  | 'INVALID_INPUT';

export interface Player {
  id: string; // UUID cố định lưu ở sessionStorage để hỗ trợ Reconnect (F5)
  socketId: string; // Socket ID hiện tại của kết nối
  name: string;
  avatar: string;
  isHost: boolean;
  isAlive: boolean;
  role?: Role;
  isConnected: boolean;
}

/**
 * Dữ liệu người chơi đã được lọc bảo mật (Anti-Cheat) trước khi gửi về từng Client
 */
export interface SanitizedPlayer {
  id: string;
  name: string;
  avatar: string;
  isHost: boolean;
  isAlive: boolean;
  role?: VisibleRole;
  isConnected: boolean;
}

export interface RoomSettings {
  maxPlayers: number; // Giới hạn từ 6 đến 16 người chơi
  nightDuration: number; // giây (30 - 45s)
  discussionDuration: number; // giây (60 - 120s)
  votingDuration: number; // giây (30s)
  rolesConfig: Record<Role, number>;
}

export interface WitchPotions {
  hasSavePotion: boolean;
  hasPoisonPotion: boolean;
}

export interface NightState {
  wolfVotes: Record<string, string>; // wolfPlayerId -> targetPlayerId
  protectedPlayerId: string | null;
  lastProtectedPlayerId: string | null; // Không được bảo vệ 1 người 2 đêm liên tiếp
  seerTargetId: string | null;
  witchSaveUsedTonight: boolean;
  witchPoisonTargetId: string | null;
}

/**
 * Toàn bộ trạng thái phòng lưu trên Server (Tuyệt đối không gửi trực tiếp object này về Client)
 */
export interface Room {
  roomId: string;
  hostId: string;
  phase: GamePhase;
  dayCount: number;
  timerEnd: number | null; // Unix timestamp (ms) thời điểm kết thúc pha hiện tại
  settings: RoomSettings;
  players: Map<string, Player>; // key: player.id (UUID)
  votes: Record<string, string | null>; // voterPlayerId -> targetPlayerId | null (phiếu trắng)
  witchPotions: Record<string, WitchPotions>; // witchPlayerId -> trạng thái 2 bình thuốc
  nightState: NightState;
  lastNightDeaths: string[];
  hunterPendingShotId: string | null; // ID của Thợ Săn đang được quyền bắn sau khi chết
  winner: Faction | null;
  createdAt: number;
}

export interface PrivateNightInfo {
  wolfVotes?: Record<string, string>;
  protectedPlayerId?: string | null;
  lastProtectedPlayerId?: string | null;
  seerTargetId?: string | null;
  witchSaveUsedTonight?: boolean;
  witchPoisonTargetId?: string | null;
}

/**
 * Trạng thái phòng đã qua bộ lọc bảo mật (Anti-Cheat) dành riêng cho một người chơi cụ thể
 */
export interface SanitizedGameState {
  roomId: string;
  hostId: string;
  selfId: string;
  phase: GamePhase;
  dayCount: number;
  timerEnd: number | null;
  remainingTime: number; // Số giây còn lại
  settings: RoomSettings;
  players: SanitizedPlayer[];
  votes: Record<string, string | null>;
  myWitchPotions?: WitchPotions;
  myNightInfo?: PrivateNightInfo;
  lastNightDeaths: string[];
  hunterPendingShotId: string | null;
  winner: Faction | null;
}

// ==========================================
// SOCKET PAYLOAD INTERFACES
// ==========================================

export interface CreateRoomPayload {
  playerName: string;
  avatar: string;
  playerId?: string;
}

export interface JoinRoomPayload {
  roomId: string;
  playerName: string;
  avatar: string;
  playerId?: string;
}

export interface LeaveRoomPayload {
  roomId: string;
}

export interface KickPlayerPayload {
  roomId: string;
  targetPlayerId: string;
}

export interface UpdateSettingsPayload {
  roomId: string;
  settings: Partial<RoomSettings>;
}

export interface StartGamePayload {
  roomId: string;
}

export interface NightActionPayload {
  roomId: string;
  actionType: NightActionType;
  targetId?: string;
}

export interface VotePayload {
  roomId: string;
  targetId: string | null;
}

export interface HunterShootPayload {
  roomId: string;
  targetId: string;
}

export interface ChatSendPayload {
  roomId: string;
  message: string;
  channel: ChatChannel;
}

export interface RoomJoinedResponse {
  roomId: string;
  playerId: string;
}

export interface RoomStateSyncPayload {
  roomState: SanitizedGameState;
}

export interface PhaseChangedPayload {
  phase: GamePhase;
  timer: number;
  timerEnd: number | null;
  message: string;
}

export interface SeerResultPayload {
  targetId: string;
  isWolf: boolean;
}

export interface WitchInfoPayload {
  victimId: string | null;
}

export interface ChatReceivePayload {
  id: string;
  senderId: string;
  senderName: string;
  message: string;
  channel: ChatChannel;
  timestamp: number;
}

export interface ErrorMessagePayload {
  code: ErrorCode;
  message: string;
}

// ==========================================
// SOCKET.IO TYPED EVENTS
// ==========================================

export interface ClientToServerEvents {
  'room:create': (payload: CreateRoomPayload) => void;
  'room:join': (payload: JoinRoomPayload) => void;
  'room:leave': (payload: LeaveRoomPayload) => void;
  'room:kick': (payload: KickPlayerPayload) => void;
  'room:update_settings': (payload: UpdateSettingsPayload) => void;
  'game:start': (payload: StartGamePayload) => void;
  'game:night_action': (payload: NightActionPayload) => void;
  'game:vote': (payload: VotePayload) => void;
  'game:hunter_shoot': (payload: HunterShootPayload) => void;
  'chat:send': (payload: ChatSendPayload) => void;
}

export interface ServerToClientEvents {
  'room:joined': (payload: RoomJoinedResponse) => void;
  'room:kicked': (payload: { roomId: string; reason: string }) => void;
  'room:state_sync': (payload: RoomStateSyncPayload) => void;
  'game:phase_changed': (payload: PhaseChangedPayload) => void;
  'game:seer_result': (payload: SeerResultPayload) => void;
  'game:witch_info': (payload: WitchInfoPayload) => void;
  'chat:receive': (payload: ChatReceivePayload) => void;
  'error:message': (payload: ErrorMessagePayload) => void;
}

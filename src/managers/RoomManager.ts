import { randomUUID } from 'crypto';
import { Server } from 'socket.io';
import {
  ClientToServerEvents,
  ErrorCode,
  NightState,
  Player,
  Role,
  Room,
  RoomSettings,
  SanitizedGameState,
  SanitizedPlayer,
  ServerToClientEvents,
  VisibleRole,
} from '../types/types';

type TypedIOServer = Server<ClientToServerEvents, ServerToClientEvents>;

export class RoomManagerError extends Error {
  public readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'RoomManagerError';
    this.code = code;
  }
}

const MIN_PLAYERS = 6;
const MAX_PLAYERS = 16;

const DEFAULT_ROLES_CONFIG: Record<Role, number> = {
  VILLAGER: 3,
  WEREWOLF: 2,
  SEER: 1,
  BODYGUARD: 1,
  WITCH: 1,
  HUNTER: 0,
};

const DEFAULT_ROOM_SETTINGS: RoomSettings = {
  maxPlayers: 12,
  nightDuration: 35,
  discussionDuration: 90,
  votingDuration: 30,
  rolesConfig: { ...DEFAULT_ROLES_CONFIG },
};

export class RoomManager {
  private rooms: Map<string, Room> = new Map();
  // Ánh xạ nhanh từ socket.id -> { roomId, playerId } để xử lý disconnect
  private socketToPlayer: Map<string, { roomId: string; playerId: string }> =
    new Map();

  /**
   * Khởi tạo trạng thái ban đêm mặc định
   */
  public static createInitialNightState(
    lastProtectedPlayerId: string | null = null
  ): NightState {
    return {
      wolfVotes: {},
      protectedPlayerId: null,
      lastProtectedPlayerId,
      seerTargetId: null,
      witchSaveUsedTonight: false,
      witchPoisonTargetId: null,
    };
  }

  /**
   * Sinh mã phòng ngẫu nhiên gồm 6 ký tự viết hoa (loại bỏ các ký tự dễ nhầm lẫn như I, O, 0, 1)
   */
  private generateRoomCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    do {
      code = '';
      for (let i = 0; i < 6; i++) {
        const randomIndex = Math.floor(Math.random() * chars.length);
        code += chars[randomIndex];
      }
    } while (this.rooms.has(code));

    return code;
  }

  /**
   * Tạo phòng mới và đặt người tạo làm Host
   */
  public createRoom(params: {
    socketId: string;
    playerName: string;
    avatar: string;
    playerId?: string;
  }): { room: Room; player: Player } {
    const cleanName = params.playerName.trim();
    if (!cleanName) {
      throw new RoomManagerError(
        'INVALID_INPUT',
        'Tên hiển thị không được để trống.'
      );
    }

    const roomId = this.generateRoomCode();
    const finalPlayerId =
      params.playerId && params.playerId.trim().length > 0
        ? params.playerId.trim()
        : randomUUID();

    const hostPlayer: Player = {
      id: finalPlayerId,
      socketId: params.socketId,
      name: cleanName,
      avatar: params.avatar || 'default',
      isHost: true,
      isAlive: true,
      isConnected: true,
    };

    const playersMap = new Map<string, Player>();
    playersMap.set(hostPlayer.id, hostPlayer);

    const newRoom: Room = {
      roomId,
      hostId: hostPlayer.id,
      phase: 'LOBBY',
      dayCount: 0,
      timerEnd: null,
      settings: {
        ...DEFAULT_ROOM_SETTINGS,
        rolesConfig: { ...DEFAULT_ROOM_SETTINGS.rolesConfig },
      },
      players: playersMap,
      votes: {},
      witchPotions: {},
      nightState: RoomManager.createInitialNightState(),
      lastNightDeaths: [],
      hunterPendingShotId: null,
      winner: null,
      createdAt: Date.now(),
    };

    this.rooms.set(roomId, newRoom);
    this.socketToPlayer.set(params.socketId, {
      roomId,
      playerId: hostPlayer.id,
    });

    return { room: newRoom, player: hostPlayer };
  }

  /**
   * Tham gia phòng hoặc kết nối lại (Reconnect) bằng playerId lưu trong sessionStorage
   */
  public joinRoom(params: {
    roomId: string;
    socketId: string;
    playerName: string;
    avatar: string;
    playerId?: string;
  }): { room: Room; player: Player; isReconnect: boolean } {
    const normalizedRoomId = params.roomId.trim().toUpperCase();
    const room = this.rooms.get(normalizedRoomId);

    if (!room) {
      throw new RoomManagerError(
        'ROOM_NOT_FOUND',
        `Không tìm thấy phòng có mã ${normalizedRoomId}.`
      );
    }

    // 1. Kiểm tra trường hợp Reconnect bằng playerId
    if (params.playerId && room.players.has(params.playerId)) {
      const existingPlayer = room.players.get(params.playerId)!;

      // Xóa mapping socket cũ nếu có
      if (existingPlayer.socketId !== params.socketId) {
        this.socketToPlayer.delete(existingPlayer.socketId);
      }

      existingPlayer.socketId = params.socketId;
      existingPlayer.isConnected = true;

      // Ở sảnh chờ cho phép cập nhật lại tên và avatar nếu người chơi đổi
      if (room.phase === 'LOBBY') {
        const trimmedName = params.playerName.trim();
        if (trimmedName) {
          existingPlayer.name = trimmedName;
        }
        if (params.avatar) {
          existingPlayer.avatar = params.avatar;
        }
      }

      this.socketToPlayer.set(params.socketId, {
        roomId: room.roomId,
        playerId: existingPlayer.id,
      });

      return { room, player: existingPlayer, isReconnect: true };
    }

    // 2. Người chơi mới tham gia: chỉ cho phép khi phòng đang ở trạng thái LOBBY
    if (room.phase !== 'LOBBY') {
      throw new RoomManagerError(
        'GAME_ALREADY_STARTED',
        'Trận đấu đã bắt đầu, không thể tham gia mới.'
      );
    }

    if (room.players.size >= room.settings.maxPlayers) {
      throw new RoomManagerError(
        'ROOM_FULL',
        'Phòng đã đầy, không thể tham gia.'
      );
    }

    const cleanName = params.playerName.trim();
    if (!cleanName) {
      throw new RoomManagerError(
        'INVALID_INPUT',
        'Tên hiển thị không được để trống.'
      );
    }

    // Kiểm tra trùng tên trong cùng một phòng
    const isNameDuplicate = Array.from(room.players.values()).some(
      (p) => p.name.toLowerCase() === cleanName.toLowerCase()
    );
    if (isNameDuplicate) {
      throw new RoomManagerError(
        'NAME_TAKEN',
        'Tên hiển thị này đã có người sử dụng trong phòng.'
      );
    }

    const finalPlayerId =
      params.playerId && params.playerId.trim().length > 0
        ? params.playerId.trim()
        : randomUUID();

    const newPlayer: Player = {
      id: finalPlayerId,
      socketId: params.socketId,
      name: cleanName,
      avatar: params.avatar || 'default',
      isHost: false,
      isAlive: true,
      isConnected: true,
    };

    room.players.set(newPlayer.id, newPlayer);
    this.socketToPlayer.set(params.socketId, {
      roomId: room.roomId,
      playerId: newPlayer.id,
    });

    return { room, player: newPlayer, isReconnect: false };
  }

  /**
   * Người chơi chủ động rời phòng
   */
  public leaveRoom(
    roomId: string,
    playerId: string
  ): {
    room: Room | null;
    removedPlayer: Player | null;
    newHostId: string | null;
  } {
    const normalizedRoomId = roomId.trim().toUpperCase();
    const room = this.rooms.get(normalizedRoomId);
    if (!room) {
      return { room: null, removedPlayer: null, newHostId: null };
    }

    const player = room.players.get(playerId);
    if (!player) {
      return { room, removedPlayer: null, newHostId: room.hostId };
    }

    this.socketToPlayer.delete(player.socketId);
    room.players.delete(playerId);
    delete room.votes[playerId];

    // Nếu phòng không còn ai, xóa phòng khỏi bộ nhớ
    if (room.players.size === 0) {
      this.rooms.delete(normalizedRoomId);
      return { room: null, removedPlayer: player, newHostId: null };
    }

    // Nếu chủ phòng rời đi, nhường quyền Host cho người chơi tiếp theo
    let newHostId: string | null = room.hostId;
    if (room.hostId === playerId) {
      const nextHost =
        Array.from(room.players.values()).find((p) => p.isConnected) ??
        Array.from(room.players.values())[0];

      if (nextHost) {
        nextHost.isHost = true;
        room.hostId = nextHost.id;
        newHostId = nextHost.id;
      }
    }

    return { room, removedPlayer: player, newHostId };
  }

  /**
   * Xử lý khi Socket bị ngắt kết nối (đóng tab, rớt mạng, hoặc F5)
   * - Nếu đang ở LOBBY: chỉ đánh dấu isConnected = false (hoặc giữ slot để F5 không mất phòng, nếu tất cả đều mất kết nối thì dọn phòng sau).
   * - Nếu đang trong trận: giữ nguyên trạng thái người chơi và đánh dấu isConnected = false để chờ Reconnect.
   */
  public handleDisconnect(socketId: string): {
    room: Room | null;
    player: Player | null;
  } {
    const mapping = this.socketToPlayer.get(socketId);
    if (!mapping) {
      return { room: null, player: null };
    }

    this.socketToPlayer.delete(socketId);

    const room = this.rooms.get(mapping.roomId);
    if (!room) {
      return { room: null, player: null };
    }

    const player = room.players.get(mapping.playerId);
    if (!player) {
      return { room, player: null };
    }

    player.isConnected = false;

    return { room, player };
  }

  /**
   * Chủ phòng kick một người chơi khác (chỉ được phép khi ở LOBBY)
   */
  public kickPlayer(params: {
    roomId: string;
    requesterId: string;
    targetPlayerId: string;
  }): { room: Room; kickedPlayer: Player } {
    const normalizedRoomId = params.roomId.trim().toUpperCase();
    const room = this.rooms.get(normalizedRoomId);

    if (!room) {
      throw new RoomManagerError('ROOM_NOT_FOUND', 'Phòng không tồn tại.');
    }

    if (room.hostId !== params.requesterId) {
      throw new RoomManagerError(
        'NOT_HOST',
        'Chỉ chủ phòng mới có quyền đuổi người chơi.'
      );
    }

    if (room.phase !== 'LOBBY') {
      throw new RoomManagerError(
        'INVALID_ACTION',
        'Không thể đuổi người chơi khi ván đấu đang diễn ra.'
      );
    }

    if (params.requesterId === params.targetPlayerId) {
      throw new RoomManagerError(
        'INVALID_ACTION',
        'Chủ phòng không thể tự đuổi chính mình.'
      );
    }

    const targetPlayer = room.players.get(params.targetPlayerId);
    if (!targetPlayer) {
      throw new RoomManagerError(
        'PLAYER_NOT_FOUND',
        'Không tìm thấy người chơi cần đuổi.'
      );
    }

    this.socketToPlayer.delete(targetPlayer.socketId);
    room.players.delete(params.targetPlayerId);

    return { room, kickedPlayer: targetPlayer };
  }

  /**
   * Chủ phòng cập nhật cấu hình phòng (số người tối đa, thời gian các pha, số lượng từng vai trò)
   */
  public updateSettings(params: {
    roomId: string;
    requesterId: string;
    newSettings: Partial<RoomSettings>;
  }): Room {
    const normalizedRoomId = params.roomId.trim().toUpperCase();
    const room = this.rooms.get(normalizedRoomId);

    if (!room) {
      throw new RoomManagerError('ROOM_NOT_FOUND', 'Phòng không tồn tại.');
    }

    if (room.hostId !== params.requesterId) {
      throw new RoomManagerError(
        'NOT_HOST',
        'Chỉ chủ phòng mới có quyền thay đổi cài đặt phòng.'
      );
    }

    if (room.phase !== 'LOBBY') {
      throw new RoomManagerError(
        'INVALID_ACTION',
        'Chỉ có thể chỉnh cài đặt khi ở sảnh chờ.'
      );
    }

    const updatedMaxPlayers =
      params.newSettings.maxPlayers ?? room.settings.maxPlayers;
    if (
      updatedMaxPlayers < MIN_PLAYERS ||
      updatedMaxPlayers > MAX_PLAYERS ||
      updatedMaxPlayers < room.players.size
    ) {
      throw new RoomManagerError(
        'INVALID_SETTINGS',
        `Số người chơi tối đa phải từ ${Math.max(
          MIN_PLAYERS,
          room.players.size
        )} đến ${MAX_PLAYERS}.`
      );
    }

    const updatedNightDuration =
      params.newSettings.nightDuration ?? room.settings.nightDuration;
    const updatedDiscussionDuration =
      params.newSettings.discussionDuration ?? room.settings.discussionDuration;
    const updatedVotingDuration =
      params.newSettings.votingDuration ?? room.settings.votingDuration;

    if (
      updatedNightDuration < 10 ||
      updatedNightDuration > 120 ||
      updatedDiscussionDuration < 15 ||
      updatedDiscussionDuration > 300 ||
      updatedVotingDuration < 10 ||
      updatedVotingDuration > 120
    ) {
      throw new RoomManagerError(
        'INVALID_SETTINGS',
        'Thời gian cấu hình cho các pha không hợp lệ.'
      );
    }

    const updatedRolesConfig: Record<Role, number> = {
      ...room.settings.rolesConfig,
      ...(params.newSettings.rolesConfig ?? {}),
    };

    // Kiểm tra số lượng từng vai trò không âm và có ít nhất 1 Ma Sói
    for (const count of Object.values(updatedRolesConfig)) {
      if (!Number.isInteger(count) || count < 0) {
        throw new RoomManagerError(
          'INVALID_SETTINGS',
          'Số lượng mỗi vai trò phải là số nguyên không âm.'
        );
      }
    }

    if (updatedRolesConfig.WEREWOLF < 1) {
      throw new RoomManagerError(
        'INVALID_SETTINGS',
        'Cấu hình phải có ít nhất 1 Ma Sói.'
      );
    }

    room.settings = {
      maxPlayers: updatedMaxPlayers,
      nightDuration: updatedNightDuration,
      discussionDuration: updatedDiscussionDuration,
      votingDuration: updatedVotingDuration,
      rolesConfig: updatedRolesConfig,
    };

    return room;
  }

  /**
   * Lọc trạng thái phòng theo nguyên tắc Anti-Cheat trước khi gửi cho một người chơi cụ thể:
   * - Người chơi luôn biết vai trò của chính mình.
   * - Khi ở LOBBY: chưa ai có vai trò (undefined).
   * - Khi ở GAME_OVER hoặc khi người xem đã chết (!viewer.isAlive): thấy được toàn bộ vai trò của mọi người.
   * - Nếu người xem là WEREWOLF: thấy được đồng đội cũng là 'WEREWOLF', những người khác hiển thị 'UNKNOWN'.
   * - Các trường hợp còn lại: vai trò của người khác hiển thị là 'UNKNOWN'.
   */
  public getSanitizedStateForPlayer(
    roomId: string,
    viewerPlayerId: string
  ): SanitizedGameState {
    const normalizedRoomId = roomId.trim().toUpperCase();
    const room = this.rooms.get(normalizedRoomId);

    if (!room) {
      throw new RoomManagerError('ROOM_NOT_FOUND', 'Phòng không tồn tại.');
    }

    const viewer = room.players.get(viewerPlayerId);
    const remainingTime =
      room.timerEnd !== null
        ? Math.max(0, Math.ceil((room.timerEnd - Date.now()) / 1000))
        : 0;

    const sanitizedPlayers: SanitizedPlayer[] = Array.from(
      room.players.values()
    ).map((target) => {
      let visibleRole: VisibleRole | undefined = undefined;

      if (room.phase !== 'LOBBY' && target.role) {
        const isSelf = viewer?.id === target.id;
        const isGameOver = room.phase === 'GAME_OVER';
        const isViewerDead = viewer ? !viewer.isAlive : false;
        const isWolfTeammate =
          viewer?.role === 'WEREWOLF' && target.role === 'WEREWOLF';

        if (isSelf || isGameOver || isViewerDead || isWolfTeammate) {
          visibleRole = target.role;
        } else {
          visibleRole = 'UNKNOWN';
        }
      }

      return {
        id: target.id,
        name: target.name,
        avatar: target.avatar,
        isHost: target.isHost,
        isAlive: target.isAlive,
        role: visibleRole,
        isConnected: target.isConnected,
      };
    });

    const sanitizedState: SanitizedGameState = {
      roomId: room.roomId,
      hostId: room.hostId,
      selfId: viewerPlayerId,
      phase: room.phase,
      dayCount: room.dayCount,
      timerEnd: room.timerEnd,
      remainingTime,
      settings: room.settings,
      players: sanitizedPlayers,
      votes: { ...room.votes },
      lastNightDeaths: [...room.lastNightDeaths],
      hunterPendingShotId: room.hunterPendingShotId,
      winner: room.winner,
    };

    if (viewer?.role === 'WITCH' && room.witchPotions[viewer.id]) {
      sanitizedState.myWitchPotions = { ...room.witchPotions[viewer.id] };
    }

    // Chỉ cung cấp thông tin hành động ban đêm tương ứng với đúng vai trò của người xem
    if (room.phase === 'NIGHT' && viewer && viewer.isAlive) {
      if (viewer.role === 'WEREWOLF') {
        sanitizedState.myNightInfo = {
          wolfVotes: { ...room.nightState.wolfVotes },
        };
      } else if (viewer.role === 'BODYGUARD') {
        sanitizedState.myNightInfo = {
          protectedPlayerId: room.nightState.protectedPlayerId,
          lastProtectedPlayerId: room.nightState.lastProtectedPlayerId,
        };
      } else if (viewer.role === 'SEER') {
        sanitizedState.myNightInfo = {
          seerTargetId: room.nightState.seerTargetId,
        };
      } else if (viewer.role === 'WITCH') {
        sanitizedState.myNightInfo = {
          witchSaveUsedTonight: room.nightState.witchSaveUsedTonight,
          witchPoisonTargetId: room.nightState.witchPoisonTargetId,
        };
      }
    }

    return sanitizedState;
  }

  /**
   * Đồng bộ trạng thái phòng (đã lọc bảo mật riêng cho từng người) tới tất cả người chơi đang kết nối trong phòng
   */
  public broadcastRoomState(io: TypedIOServer, roomId: string): void {
    const normalizedRoomId = roomId.trim().toUpperCase();
    const room = this.rooms.get(normalizedRoomId);
    if (!room) return;

    for (const player of room.players.values()) {
      if (!player.isConnected) continue;

      const sanitizedState = this.getSanitizedStateForPlayer(
        room.roomId,
        player.id
      );

      io.to(player.socketId).emit('room:state_sync', {
        roomState: sanitizedState,
      });
    }
  }

  /**
   * Các hàm tra cứu tiện ích
   */
  public getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId.trim().toUpperCase());
  }

  public getPlayerBySocketId(
    socketId: string
  ): { room: Room; player: Player } | undefined {
    const mapping = this.socketToPlayer.get(socketId);
    if (!mapping) return undefined;

    const room = this.rooms.get(mapping.roomId);
    if (!room) return undefined;

    const player = room.players.get(mapping.playerId);
    if (!player) return undefined;

    return { room, player };
  }
}

export const roomManager = new RoomManager();

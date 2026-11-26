import { randomInt, randomUUID } from 'crypto';
import { Server } from 'socket.io';
import { RoomManager, RoomManagerError } from '../managers/RoomManager';
import {
  ChatChannel,
  ChatReceivePayload,
  ClientToServerEvents,
  Faction,
  GamePhase,
  NightActionType,
  Player,
  Role,
  Room,
  SanitizedGameState,
  ServerToClientEvents,
} from '../types/types';

type TypedIOServer = Server<ClientToServerEvents, ServerToClientEvents>;

const MORNING_DURATION_SECONDS = 10;
const HUNTER_SHOOT_DURATION_SECONDS = 20;
const MIN_PLAYERS_TO_START = 6;
const MAX_PLAYERS_TO_START = 16;

export class GameEngine {
  private io: TypedIOServer;
  private roomManager: RoomManager;
  private roomTimers: Map<string, NodeJS.Timeout> = new Map();
  // Lưu pha tiếp theo sau khi Thợ Săn bắn xong ('DISCUSSION' nếu chết ban đêm, 'NIGHT' nếu bị treo cổ ban ngày)
  private nextPhaseAfterHunter: Map<string, 'DISCUSSION' | 'NIGHT'> = new Map();

  constructor(io: TypedIOServer, roomManager: RoomManager) {
    this.io = io;
    this.roomManager = roomManager;
  }

  /**
   * Bắt đầu ván đấu mới (chỉ Host mới có quyền gọi khi ở LOBBY)
   */
  public startGame(roomId: string, requesterId: string): void {
    const room = this.getValidRoom(roomId);

    if (room.hostId !== requesterId) {
      throw new RoomManagerError(
        'NOT_HOST',
        'Chỉ chủ phòng mới có quyền bắt đầu trò chơi.'
      );
    }

    if (room.phase !== 'LOBBY' && room.phase !== 'GAME_OVER') {
      throw new RoomManagerError(
        'GAME_ALREADY_STARTED',
        'Ván đấu đang diễn ra.'
      );
    }

    const playerCount = room.players.size;
    if (
      playerCount < MIN_PLAYERS_TO_START ||
      playerCount > MAX_PLAYERS_TO_START
    ) {
      throw new RoomManagerError(
        'INVALID_SETTINGS',
        `Cần từ ${MIN_PLAYERS_TO_START} đến ${MAX_PLAYERS_TO_START} người chơi để bắt đầu (hiện có ${playerCount}).`
      );
    }

    // Chia vai trò ngẫu nhiên cho người chơi
    this.assignRoles(room);

    // Khởi tạo lại các thông số trận đấu
    room.dayCount = 0;
    room.winner = null;
    room.votes = {};
    room.lastNightDeaths = [];
    room.hunterPendingShotId = null;
    room.nightState = RoomManager.createInitialNightState(null);
    this.nextPhaseAfterHunter.delete(room.roomId);

    // Chuyển ngay sang pha Đêm đầu tiên
    this.transitionToNight(room.roomId);
  }

  /**
   * Đưa phòng về lại trạng thái LOBBY để chơi lại ("Chơi lại")
   */
  public resetToLobby(roomId: string, requesterId: string): void {
    const room = this.getValidRoom(roomId);

    if (room.hostId !== requesterId) {
      throw new RoomManagerError(
        'NOT_HOST',
        'Chỉ chủ phòng mới có thể đưa phòng về sảnh chờ.'
      );
    }

    this.clearRoomTimer(room.roomId);
    this.nextPhaseAfterHunter.delete(room.roomId);

    room.phase = 'LOBBY';
    room.dayCount = 0;
    room.timerEnd = null;
    room.votes = {};
    room.witchPotions = {};
    room.nightState = RoomManager.createInitialNightState(null);
    room.lastNightDeaths = [];
    room.hunterPendingShotId = null;
    room.winner = null;

    for (const player of room.players.values()) {
      player.isAlive = true;
      player.role = undefined;
    }

    this.emitPhaseChanged(
      room,
      0,
      'Đã quay về sảnh chờ. Chủ phòng có thể bắt đầu ván mới.'
    );
    this.broadcastSanitizedState(room.roomId);
  }

  /**
   * Chia vai trò ngẫu nhiên dựa trên cấu hình phòng (Fisher-Yates Shuffle)
   */
  private assignRoles(room: Room): void {
    const playerCount = room.players.size;
    const config = room.settings.rolesConfig;

    const specialAndWolfCount =
      config.WEREWOLF +
      config.SEER +
      config.BODYGUARD +
      config.WITCH +
      config.HUNTER;

    if (config.WEREWOLF < 1) {
      throw new RoomManagerError(
        'INVALID_SETTINGS',
        'Phải có ít nhất 1 Ma Sói trong cấu hình.'
      );
    }

    if (specialAndWolfCount >= playerCount) {
      throw new RoomManagerError(
        'INVALID_SETTINGS',
        `Tổng số Sói và chức năng đặc biệt (${specialAndWolfCount}) phải nhỏ hơn tổng số người chơi (${playerCount}).`
      );
    }

    // Tự động cân bằng số Dân Làng theo đúng số người thực tế trong phòng
    const villagerCount = playerCount - specialAndWolfCount;

    const rolePool: Role[] = [
      ...Array<Role>(config.WEREWOLF).fill('WEREWOLF'),
      ...Array<Role>(config.SEER).fill('SEER'),
      ...Array<Role>(config.BODYGUARD).fill('BODYGUARD'),
      ...Array<Role>(config.WITCH).fill('WITCH'),
      ...Array<Role>(config.HUNTER).fill('HUNTER'),
      ...Array<Role>(villagerCount).fill('VILLAGER'),
    ];

    // Thuật toán xáo bài Fisher-Yates dùng CSPRNG
    for (let i = rolePool.length - 1; i > 0; i--) {
      const j = randomInt(0, i + 1);
      const temp = rolePool[i];
      rolePool[i] = rolePool[j];
      rolePool[j] = temp;
    }

    room.witchPotions = {};
    const playersList = Array.from(room.players.values());

    playersList.forEach((player, index) => {
      const assignedRole = rolePool[index];
      player.role = assignedRole;
      player.isAlive = true;

      if (assignedRole === 'WITCH') {
        room.witchPotions[player.id] = {
          hasSavePotion: true,
          hasPoisonPotion: true,
        };
      }
    });
  }

  // ==========================================
  // STATE MACHINE & PHASE TRANSITIONS
  // ==========================================

  /**
   * Pha 1: NIGHT (Ban đêm)
   */
  public transitionToNight(roomId: string): void {
    const room = this.getValidRoom(roomId);
    this.clearRoomTimer(room.roomId);

    room.phase = 'NIGHT';
    room.dayCount += 1;
    room.votes = {};
    room.hunterPendingShotId = null;
    room.nightState = RoomManager.createInitialNightState(
      room.nightState.protectedPlayerId
    );

    const duration = room.settings.nightDuration;
    this.schedulePhaseTimer(
      room,
      duration,
      `Đêm thứ ${room.dayCount} đã buông xuống. Các chức năng hãy thức dậy hành động!`,
      () => {
        this.resolveNightAndTransitionToMorning(room.roomId);
      }
    );
  }

  /**
   * Xử lý kết quả ban đêm theo thứ tự ưu tiên: Bảo vệ -> Sói -> Phù thủy -> Tiên tri
   * Sau đó chuyển sang pha MORNING
   */
  private resolveNightAndTransitionToMorning(roomId: string): void {
    const room = this.roomManager.getRoom(roomId);
    if (!room || room.phase !== 'NIGHT') return;

    this.clearRoomTimer(room.roomId);

    const deathsSet = new Set<string>();

    // 1. Xác định mục tiêu bị Sói cắn nhiều phiếu nhất
    const wolfTargetId = this.getLeadingWolfTarget(room);

    // 2. Kiểm tra Bảo Vệ: Nếu mục tiêu bị cắn trùng với người được Bảo Vệ thì không chết
    const isProtected =
      wolfTargetId !== null &&
      wolfTargetId === room.nightState.protectedPlayerId;

    let effectiveWolfVictimId: string | null = isProtected
      ? null
      : wolfTargetId;

    // 3. Kiểm tra Phù Thủy dùng Bình Cứu
    if (room.nightState.witchSaveUsedTonight) {
      // Trừ bình cứu của Phù Thủy còn sống
      for (const player of room.players.values()) {
        if (
          player.isAlive &&
          player.role === 'WITCH' &&
          room.witchPotions[player.id]?.hasSavePotion
        ) {
          room.witchPotions[player.id].hasSavePotion = false;
        }
      }
      effectiveWolfVictimId = null;
    }

    if (effectiveWolfVictimId) {
      deathsSet.add(effectiveWolfVictimId);
    }

    // 4. Kiểm tra Phù Thủy dùng Bình Độc (Bình độc xuyên qua Bảo Vệ)
    const poisonedTargetId = room.nightState.witchPoisonTargetId;
    if (poisonedTargetId) {
      for (const player of room.players.values()) {
        if (
          player.isAlive &&
          player.role === 'WITCH' &&
          room.witchPotions[player.id]?.hasPoisonPotion
        ) {
          room.witchPotions[player.id].hasPoisonPotion = false;
        }
      }
      deathsSet.add(poisonedTargetId);
    }

    // Cập nhật trạng thái sống/chết của các nạn nhân
    const deadPlayerNames: string[] = [];
    let deadHunterId: string | null = null;

    for (const deadId of deathsSet) {
      const victim = room.players.get(deadId);
      if (victim && victim.isAlive) {
        victim.isAlive = false;
        deadPlayerNames.push(victim.name);
        if (victim.role === 'HUNTER') {
          deadHunterId = victim.id;
        }
      }
    }

    room.lastNightDeaths = Array.from(deathsSet);

    // Kiểm tra điều kiện thắng ngay khi có người chết ban đêm
    const winner = this.checkWinCondition(room);
    if (winner) {
      this.transitionToGameOver(room, winner);
      return;
    }

    // Chuyển sang pha MORNING_ANNOUNCEMENT (10 giây)
    room.phase = 'MORNING';
    const morningMessage =
      deadPlayerNames.length > 0
        ? `Trời sáng rồi! Đêm qua ${deadPlayerNames.join(', ')} đã bị sát hại.`
        : 'Trời sáng rồi! Đêm qua là một đêm bình yên, không ai bị sát hại.';

    this.schedulePhaseTimer(
      room,
      MORNING_DURATION_SECONDS,
      morningMessage,
      () => {
        if (deadHunterId) {
          this.transitionToHunterShoot(room.roomId, deadHunterId, 'DISCUSSION');
        } else {
          this.transitionToDiscussion(room.roomId);
        }
      }
    );
  }

  /**
   * Pha 3: DISCUSSION (Thảo luận ban ngày)
   */
  public transitionToDiscussion(roomId: string): void {
    const room = this.roomManager.getRoom(roomId);
    if (!room) return;

    this.clearRoomTimer(room.roomId);
    room.phase = 'DISCUSSION';
    room.hunterPendingShotId = null;

    const duration = room.settings.discussionDuration;
    this.schedulePhaseTimer(
      room,
      duration,
      `Thảo luận ngày thứ ${room.dayCount}. Hãy tìm ra kẻ giả mạo trong làng!`,
      () => {
        this.transitionToVoting(room.roomId);
      }
    );
  }

  /**
   * Pha 4: VOTING (Bỏ phiếu treo cổ)
   */
  public transitionToVoting(roomId: string): void {
    const room = this.roomManager.getRoom(roomId);
    if (!room) return;

    this.clearRoomTimer(room.roomId);
    room.phase = 'VOTING';
    room.votes = {};

    const duration = room.settings.votingDuration;
    this.schedulePhaseTimer(
      room,
      duration,
      'Đã đến giờ bỏ phiếu! Hãy chọn người bạn nghi ngờ là Ma Sói hoặc bỏ phiếu trắng.',
      () => {
        this.resolveVotingAndTransition(room.roomId);
      }
    );
  }

  /**
   * Pha đặc biệt: HUNTER_SHOOT (Thợ săn kéo theo 1 người khi chết)
   */
  private transitionToHunterShoot(
    roomId: string,
    hunterId: string,
    nextPhase: 'DISCUSSION' | 'NIGHT'
  ): void {
    const room = this.roomManager.getRoom(roomId);
    if (!room) return;

    this.clearRoomTimer(room.roomId);
    const hunter = room.players.get(hunterId);
    if (!hunter) {
      if (nextPhase === 'DISCUSSION') {
        this.transitionToDiscussion(roomId);
      } else {
        this.transitionToNight(roomId);
      }
      return;
    }

    room.phase = 'HUNTER_SHOOT';
    room.hunterPendingShotId = hunterId;
    this.nextPhaseAfterHunter.set(room.roomId, nextPhase);

    this.schedulePhaseTimer(
      room,
      HUNTER_SHOOT_DURATION_SECONDS,
      `Thợ Săn ${hunter.name} đã ngã xuống! Thợ Săn có ${HUNTER_SHOOT_DURATION_SECONDS} giây để chọn bắn 1 người.`,
      () => {
        // Hết giờ mà Thợ Săn không bắn thì bỏ qua lượt bắn và chuyển sang pha kế tiếp
        this.finishHunterPhase(room.roomId);
      }
    );
  }

  /**
   * Kết thúc pha HUNTER_SHOOT để chuyển sang pha tiếp theo
   */
  private finishHunterPhase(roomId: string): void {
    const room = this.roomManager.getRoom(roomId);
    if (!room) return;

    this.clearRoomTimer(room.roomId);
    room.hunterPendingShotId = null;

    const winner = this.checkWinCondition(room);
    if (winner) {
      this.transitionToGameOver(room, winner);
      return;
    }

    const nextPhase = this.nextPhaseAfterHunter.get(room.roomId) ?? 'NIGHT';
    this.nextPhaseAfterHunter.delete(room.roomId);

    if (nextPhase === 'DISCUSSION') {
      this.transitionToDiscussion(room.roomId);
    } else {
      this.transitionToNight(room.roomId);
    }
  }

  /**
   * Pha kết thúc: GAME_OVER
   */
  private transitionToGameOver(room: Room, winner: Faction): void {
    this.clearRoomTimer(room.roomId);
    this.nextPhaseAfterHunter.delete(room.roomId);

    room.phase = 'GAME_OVER';
    room.winner = winner;
    room.timerEnd = null;
    room.hunterPendingShotId = null;

    const winMessage =
      winner === 'VILLAGER'
        ? 'Chiến thắng thuộc về Phe Dân Làng! Toàn bộ Ma Sói đã bị tiêu diệt.'
        : 'Chiến thắng thuộc về Phe Ma Sói! Bóng tối đã bao trùm ngôi làng.';

    this.emitPhaseChanged(room, 0, winMessage);
    this.broadcastSanitizedState(room.roomId);
  }

  // ==========================================
  // XỬ LÝ HÀNH ĐỘNG CỦA NGƯỜI CHƠI (ACTIONS)
  // ==========================================

  /**
   * Xử lý hành động ban đêm của các vai trò chức năng:
   * - KILL (Ma Sói)
   * - PROTECT (Bảo Vệ)
   * - SEER (Tiên Tri)
   * - WITCH_SAVE (Phù Thủy cứu)
   * - WITCH_POISON (Phù Thủy quăng độc)
   */
  public handleNightAction(params: {
    roomId: string;
    actorId: string;
    actionType: NightActionType;
    targetId?: string;
  }): void {
    const room = this.getValidRoom(params.roomId);

    if (room.phase !== 'NIGHT') {
      throw new RoomManagerError(
        'INVALID_ACTION',
        'Chỉ có thể thực hiện kỹ năng này vào ban đêm.'
      );
    }

    const actor = room.players.get(params.actorId);
    if (!actor) {
      throw new RoomManagerError('PLAYER_NOT_FOUND', 'Người chơi không hợp lệ.');
    }

    if (!actor.isAlive) {
      throw new RoomManagerError(
        'PLAYER_DEAD',
        'Người đã chết không thể thực hiện kỹ năng.'
      );
    }

    switch (params.actionType) {
      case 'KILL': {
        if (actor.role !== 'WEREWOLF') {
          throw new RoomManagerError(
            'INVALID_ACTION',
            'Chỉ Ma Sói mới có thể chọn mục tiêu cắn.'
          );
        }

        const target = this.getValidAliveTarget(room, params.targetId);
        room.nightState.wolfVotes[actor.id] = target.id;

        // Cập nhật mục tiêu bị Sói nhắm tới cho Phù Thủy (nếu Phù Thủy còn sống và còn Bình Cứu)
        this.notifyWitchOfWolfVictim(room);
        this.broadcastSanitizedState(room.roomId);
        break;
      }

      case 'PROTECT': {
        if (actor.role !== 'BODYGUARD') {
          throw new RoomManagerError(
            'INVALID_ACTION',
            'Chỉ Bảo Vệ mới có thể thực hiện hành động này.'
          );
        }

        const target = this.getValidAliveTarget(room, params.targetId);
        if (
          room.nightState.lastProtectedPlayerId !== null &&
          room.nightState.lastProtectedPlayerId === target.id
        ) {
          throw new RoomManagerError(
            'INVALID_ACTION',
            'Không được bảo vệ cùng một người trong 2 đêm liên tiếp.'
          );
        }

        room.nightState.protectedPlayerId = target.id;
        this.syncSinglePlayerState(room, actor);
        break;
      }

      case 'SEER': {
        if (actor.role !== 'SEER') {
          throw new RoomManagerError(
            'INVALID_ACTION',
            'Chỉ Tiên Tri mới có thể soi vai trò.'
          );
        }

        if (room.nightState.seerTargetId !== null) {
          throw new RoomManagerError(
            'INVALID_ACTION',
            'Mỗi đêm Tiên Tri chỉ được soi tối đa 1 người.'
          );
        }

        const target = this.getValidAliveTarget(room, params.targetId);
        if (target.id === actor.id) {
          throw new RoomManagerError(
            'INVALID_ACTION',
            'Tiên Tri không cần tự soi chính mình.'
          );
        }

        room.nightState.seerTargetId = target.id;

        // Gửi kết quả soi riêng cho socket của Tiên Tri
        this.io.to(actor.socketId).emit('game:seer_result', {
          targetId: target.id,
          isWolf: target.role === 'WEREWOLF',
        });
        break;
      }

      case 'WITCH_SAVE': {
        if (actor.role !== 'WITCH') {
          throw new RoomManagerError(
            'INVALID_ACTION',
            'Chỉ Phù Thủy mới có thể sử dụng Bình Cứu.'
          );
        }

        const potions = room.witchPotions[actor.id];
        if (!potions || !potions.hasSavePotion) {
          throw new RoomManagerError(
            'INVALID_ACTION',
            'Bạn đã sử dụng hết Bình Cứu.'
          );
        }

        const currentWolfVictimId = this.getLeadingWolfTarget(room);
        if (!currentWolfVictimId) {
          throw new RoomManagerError(
            'INVALID_ACTION',
            'Hiện chưa có ai bị Ma Sói cắn để cứu.'
          );
        }

        room.nightState.witchSaveUsedTonight =
          !room.nightState.witchSaveUsedTonight;
        this.syncSinglePlayerState(room, actor);
        break;
      }

      case 'WITCH_POISON': {
        if (actor.role !== 'WITCH') {
          throw new RoomManagerError(
            'INVALID_ACTION',
            'Chỉ Phù Thủy mới có thể sử dụng Bình Độc.'
          );
        }

        const potions = room.witchPotions[actor.id];
        if (!potions || !potions.hasPoisonPotion) {
          throw new RoomManagerError(
            'INVALID_ACTION',
            'Bạn đã sử dụng hết Bình Độc.'
          );
        }

        const target = this.getValidAliveTarget(room, params.targetId);
        room.nightState.witchPoisonTargetId = target.id;
        this.syncSinglePlayerState(room, actor);
        break;
      }
    }
  }

  /**
   * Xử lý bỏ phiếu treo cổ ban ngày
   */
  public handleVote(params: {
    roomId: string;
    voterId: string;
    targetId: string | null;
  }): void {
    const room = this.getValidRoom(params.roomId);

    if (room.phase !== 'VOTING') {
      throw new RoomManagerError(
        'INVALID_ACTION',
        'Hiện không phải thời gian bỏ phiếu.'
      );
    }

    const voter = room.players.get(params.voterId);
    if (!voter) {
      throw new RoomManagerError('PLAYER_NOT_FOUND', 'Người chơi không tồn tại.');
    }

    if (!voter.isAlive) {
      throw new RoomManagerError(
        'PLAYER_DEAD',
        'Người đã chết không có quyền bỏ phiếu.'
      );
    }

    if (params.targetId !== null) {
      const target = this.getValidAliveTarget(room, params.targetId);
      room.votes[voter.id] = target.id;
    } else {
      // Phiếu trắng
      room.votes[voter.id] = null;
    }

    this.broadcastSanitizedState(room.roomId);

    // Nếu tất cả người chơi còn sống đều đã bỏ phiếu thì kết thúc pha bỏ phiếu sớm
    const aliveCount = Array.from(room.players.values()).filter(
      (p) => p.isAlive
    ).length;
    const votedCount = Object.keys(room.votes).length;

    if (votedCount >= aliveCount) {
      this.resolveVotingAndTransition(room.roomId);
    }
  }

  /**
   * Tính kết quả bỏ phiếu ban ngày
   */
  private resolveVotingAndTransition(roomId: string): void {
    const room = this.roomManager.getRoom(roomId);
    if (!room || room.phase !== 'VOTING') return;

    this.clearRoomTimer(room.roomId);

    const voteCounts = new Map<string, number>();
    for (const [voterId, targetId] of Object.entries(room.votes)) {
      const voter = room.players.get(voterId);
      if (!voter || !voter.isAlive || targetId === null) continue;

      const target = room.players.get(targetId);
      if (!target || !target.isAlive) continue;

      voteCounts.set(targetId, (voteCounts.get(targetId) ?? 0) + 1);
    }

    let maxVotes = 0;
    let topCandidates: string[] = [];

    for (const [candidateId, count] of voteCounts.entries()) {
      if (count > maxVotes) {
        maxVotes = count;
        topCandidates = [candidateId];
      } else if (count === maxVotes && maxVotes > 0) {
        topCandidates.push(candidateId);
      }
    }

    // Nếu có duy nhất 1 người cao phiếu nhất thì bị treo cổ; hòa phiếu thì không ai chết
    let executedPlayer: Player | null = null;
    if (topCandidates.length === 1) {
      const target = room.players.get(topCandidates[0]);
      if (target && target.isAlive) {
        target.isAlive = false;
        executedPlayer = target;
      }
    }

    // Kiểm tra điều kiện thắng sau khi treo cổ
    const winner = this.checkWinCondition(room);
    if (winner) {
      this.transitionToGameOver(room, winner);
      return;
    }

    // Nếu người bị treo cổ là Thợ Săn -> Kích hoạt kỹ năng bắn trước khi vào Đêm
    if (executedPlayer && executedPlayer.role === 'HUNTER') {
      this.transitionToHunterShoot(room.roomId, executedPlayer.id, 'NIGHT');
      return;
    }

    this.transitionToNight(room.roomId);
  }

  /**
   * Xử lý kỹ năng Thợ Săn bắn kéo theo 1 người khi chết
   */
  public handleHunterShoot(params: {
    roomId: string;
    hunterId: string;
    targetId: string;
  }): void {
    const room = this.getValidRoom(params.roomId);

    if (
      room.phase !== 'HUNTER_SHOOT' ||
      room.hunterPendingShotId !== params.hunterId
    ) {
      throw new RoomManagerError(
        'INVALID_ACTION',
        'Bạn không thể sử dụng kỹ năng Thợ Săn lúc này.'
      );
    }

    const hunter = room.players.get(params.hunterId);
    if (!hunter || hunter.role !== 'HUNTER') {
      throw new RoomManagerError(
        'INVALID_ACTION',
        'Người chơi không phải là Thợ Săn.'
      );
    }

    const target = this.getValidAliveTarget(room, params.targetId);
    target.isAlive = false;

    this.finishHunterPhase(room.roomId);
  }

  /**
   * Xử lý gửi tin nhắn Chat đa kênh ('PUBLIC' | 'WOLF' | 'DEAD') đảm bảo bảo mật
   */
  public handleChat(params: {
    roomId: string;
    senderId: string;
    message: string;
    channel: ChatChannel;
  }): void {
    const room = this.getValidRoom(params.roomId);
    const sender = room.players.get(params.senderId);

    if (!sender) {
      throw new RoomManagerError('PLAYER_NOT_FOUND', 'Người chơi không hợp lệ.');
    }

    const cleanMessage = params.message.trim();
    if (!cleanMessage) return;

    const chatPayload: ChatReceivePayload = {
      id: randomUUID(),
      senderId: sender.id,
      senderName: sender.name,
      message: cleanMessage.slice(0, 500),
      channel: params.channel,
      timestamp: Date.now(),
    };

    if (params.channel === 'PUBLIC') {
      // Khi trận đấu đang diễn ra, người chết không được chat kênh PUBLIC và ban đêm không được chat PUBLIC
      if (room.phase !== 'LOBBY' && room.phase !== 'GAME_OVER') {
        if (!sender.isAlive) {
          throw new RoomManagerError(
            'PLAYER_DEAD',
            'Người đã chết chỉ có thể trò chuyện ở kênh Linh Hồn (DEAD).'
          );
        }
        if (room.phase === 'NIGHT') {
          throw new RoomManagerError(
            'UNAUTHORIZED_CHANNEL',
            'Không thể chat công khai vào ban đêm.'
          );
        }
      }

      for (const player of room.players.values()) {
        if (player.isConnected) {
          this.io.to(player.socketId).emit('chat:receive', chatPayload);
        }
      }
      return;
    }

    if (params.channel === 'WOLF') {
      if (
        room.phase !== 'NIGHT' ||
        !sender.isAlive ||
        sender.role !== 'WEREWOLF'
      ) {
        throw new RoomManagerError(
          'UNAUTHORIZED_CHANNEL',
          'Chỉ Ma Sói còn sống mới có thể chat kênh Sói vào ban đêm.'
        );
      }

      // Gửi tin nhắn kênh Sói cho các Ma Sói khác và những người đã chết (khán giả)
      for (const player of room.players.values()) {
        if (
          player.isConnected &&
          (player.role === 'WEREWOLF' || !player.isAlive)
        ) {
          this.io.to(player.socketId).emit('chat:receive', chatPayload);
        }
      }
      return;
    }

    if (params.channel === 'DEAD') {
      if (sender.isAlive && room.phase !== 'GAME_OVER') {
        throw new RoomManagerError(
          'UNAUTHORIZED_CHANNEL',
          'Chỉ những người đã chết mới có thể chat ở kênh Linh Hồn.'
        );
      }

      for (const player of room.players.values()) {
        if (
          player.isConnected &&
          (!player.isAlive || room.phase === 'GAME_OVER')
        ) {
          this.io.to(player.socketId).emit('chat:receive', chatPayload);
        }
      }
    }
  }

  // ==========================================
  // ANTI-CHEAT, WIN CONDITION & HELPERS
  // ==========================================

  /**
   * Hàm ẩn thông tin bí mật của người chơi khác (Anti-Cheat Principle)
   */
  public sanitizeGameStateForPlayer(
    roomId: string,
    playerId: string
  ): SanitizedGameState {
    return this.roomManager.getSanitizedStateForPlayer(roomId, playerId);
  }

  /**
   * Kiểm tra điều kiện thắng/thua:
   * - Phe Dân thắng: Số Sói còn sống === 0
   * - Phe Sói thắng: Số Sói còn sống >= Số Dân còn sống
   */
  public checkWinCondition(room: Room): Faction | null {
    let aliveWolves = 0;
    let aliveVillagers = 0;

    for (const player of room.players.values()) {
      if (!player.isAlive) continue;
      if (player.role === 'WEREWOLF') {
        aliveWolves += 1;
      } else {
        aliveVillagers += 1;
      }
    }

    if (aliveWolves === 0) {
      return 'VILLAGER';
    }

    if (aliveWolves >= aliveVillagers) {
      return 'WEREWOLF';
    }

    return null;
  }

  /**
   * Tìm mục tiêu đang bị Sói bỏ phiếu cắn nhiều nhất trong đêm
   */
  private getLeadingWolfTarget(room: Room): string | null {
    const counts = new Map<string, number>();

    for (const [wolfId, targetId] of Object.entries(
      room.nightState.wolfVotes
    )) {
      const wolf = room.players.get(wolfId);
      const target = room.players.get(targetId);
      if (
        !wolf ||
        !wolf.isAlive ||
        wolf.role !== 'WEREWOLF' ||
        !target ||
        !target.isAlive
      ) {
        continue;
      }
      counts.set(targetId, (counts.get(targetId) ?? 0) + 1);
    }

    let maxVotes = 0;
    let topTargets: string[] = [];

    for (const [targetId, count] of counts.entries()) {
      if (count > maxVotes) {
        maxVotes = count;
        topTargets = [targetId];
      } else if (count === maxVotes && maxVotes > 0) {
        topTargets.push(targetId);
      }
    }

    if (topTargets.length === 0) return null;
    if (topTargets.length === 1) return topTargets[0];

    // Nếu các Sói chia phiếu hòa nhau, lấy mục tiêu đầu tiên trong danh sách cao phiếu nhất
    return topTargets[0];
  }

  /**
   * Gửi thông báo riêng cho Phù Thủy biết ai đang bị Sói cắn (chỉ gửi nếu Phù Thủy còn sống và còn Bình Cứu)
   */
  private notifyWitchOfWolfVictim(room: Room): void {
    const victimId = this.getLeadingWolfTarget(room);

    for (const player of room.players.values()) {
      if (
        player.isConnected &&
        player.isAlive &&
        player.role === 'WITCH' &&
        room.witchPotions[player.id]?.hasSavePotion
      ) {
        this.io.to(player.socketId).emit('game:witch_info', {
          victimId,
        });
      }
    }
  }

  private getValidRoom(roomId: string): Room {
    const room = this.roomManager.getRoom(roomId);
    if (!room) {
      throw new RoomManagerError('ROOM_NOT_FOUND', 'Phòng không tồn tại.');
    }
    return room;
  }

  private getValidAliveTarget(room: Room, targetId?: string): Player {
    if (!targetId) {
      throw new RoomManagerError(
        'INVALID_ACTION',
        'Vui lòng chọn một mục tiêu hợp lệ.'
      );
    }

    const target = room.players.get(targetId);
    if (!target) {
      throw new RoomManagerError(
        'PLAYER_NOT_FOUND',
        'Mục tiêu được chọn không tồn tại.'
      );
    }

    if (!target.isAlive) {
      throw new RoomManagerError(
        'INVALID_ACTION',
        'Không thể chọn mục tiêu đã chết.'
      );
    }

    return target;
  }

  private schedulePhaseTimer(
    room: Room,
    durationSeconds: number,
    message: string,
    onTimeout: () => void
  ): void {
    this.clearRoomTimer(room.roomId);

    room.timerEnd = Date.now() + durationSeconds * 1000;
    this.emitPhaseChanged(room, durationSeconds, message);
    this.broadcastSanitizedState(room.roomId);

    const timer = setTimeout(() => {
      this.roomTimers.delete(room.roomId);
      onTimeout();
    }, durationSeconds * 1000);

    this.roomTimers.set(room.roomId, timer);
  }

  private emitPhaseChanged(
    room: Room,
    durationSeconds: number,
    message: string
  ): void {
    for (const player of room.players.values()) {
      if (!player.isConnected) continue;
      this.io.to(player.socketId).emit('game:phase_changed', {
        phase: room.phase,
        timer: durationSeconds,
        timerEnd: room.timerEnd,
        message,
      });
    }
  }

  private syncSinglePlayerState(room: Room, player: Player): void {
    if (!player.isConnected) return;
    const sanitized = this.sanitizeGameStateForPlayer(room.roomId, player.id);
    this.io.to(player.socketId).emit('room:state_sync', {
      roomState: sanitized,
    });
  }

  private broadcastSanitizedState(roomId: string): void {
    this.roomManager.broadcastRoomState(this.io, roomId);
  }

  /**
   * Đồng bộ lại thông tin riêng tư của pha hiện tại cho người chơi vừa Reconnect (F5) giữa trận
   */
  public syncReconnectedPlayer(roomId: string, playerId: string): void {
    const room = this.roomManager.getRoom(roomId);
    if (!room) return;

    const player = room.players.get(playerId);
    if (!player || !player.isConnected) return;

    const remainingTime =
      room.timerEnd !== null
        ? Math.max(0, Math.ceil((room.timerEnd - Date.now()) / 1000))
        : 0;

    // 1. Gửi lại thông tin pha hiện tại và thời gian đếm ngược
    this.io.to(player.socketId).emit('game:phase_changed', {
      phase: room.phase,
      timer: remainingTime,
      timerEnd: room.timerEnd,
      message: this.getDefaultPhaseMessage(room),
    });

    // 2. Nếu đang ở ban đêm, khôi phục thông tin mật cho Tiên Tri và Phù Thủy
    if (room.phase === 'NIGHT' && player.isAlive) {
      if (
        player.role === 'SEER' &&
        room.nightState.seerTargetId !== null
      ) {
        const target = room.players.get(room.nightState.seerTargetId);
        if (target) {
          this.io.to(player.socketId).emit('game:seer_result', {
            targetId: target.id,
            isWolf: target.role === 'WEREWOLF',
          });
        }
      }

      if (
        player.role === 'WITCH' &&
        room.witchPotions[player.id]?.hasSavePotion
      ) {
        const victimId = this.getLeadingWolfTarget(room);
        this.io.to(player.socketId).emit('game:witch_info', {
          victimId,
        });
      }
    }
  }

  private getDefaultPhaseMessage(room: Room): string {
    switch (room.phase) {
      case 'NIGHT':
        return `Đêm thứ ${room.dayCount} đang diễn ra. Các chức năng đang bí mật hành động!`;
      case 'MORNING':
        return 'Trời đã sáng! Đang công bố kết quả đêm qua.';
      case 'DISCUSSION':
        return `Thảo luận ngày thứ ${room.dayCount}. Hãy tìm ra kẻ giả mạo trong làng!`;
      case 'VOTING':
        return 'Đang trong thời gian bỏ phiếu phán quyết!';
      case 'HUNTER_SHOOT':
        return 'Thợ Săn đang chọn mục tiêu cuối cùng!';
      case 'GAME_OVER':
        return room.winner === 'VILLAGER'
          ? 'Chiến thắng thuộc về Phe Dân Làng!'
          : 'Chiến thắng thuộc về Phe Ma Sói!';
      default:
        return 'Đang ở sảnh chờ.';
    }
  }

  public clearRoomTimer(roomId: string): void {
    const normalizedId = roomId.trim().toUpperCase();
    const existingTimer = this.roomTimers.get(normalizedId);
    if (existingTimer) {
      clearTimeout(existingTimer);
      this.roomTimers.delete(normalizedId);
    }
  }
}

import { Server, Socket } from 'socket.io';
import { GameEngine } from '../core/GameEngine';
import { RoomManager, RoomManagerError } from '../managers/RoomManager';
import {
  ClientToServerEvents,
  ErrorCode,
  ServerToClientEvents,
} from '../types/types';

type TypedIOServer = Server<ClientToServerEvents, ServerToClientEvents>;
type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

export function registerSocketHandlers(
  io: TypedIOServer,
  roomManager: RoomManager,
  gameEngine: GameEngine
): void {
  const emitSocketError = (
    socket: TypedSocket,
    error: unknown,
    fallbackCode: ErrorCode = 'INVALID_ACTION'
  ): void => {
    if (error instanceof RoomManagerError) {
      socket.emit('error:message', {
        code: error.code,
        message: error.message,
      });
      return;
    }

    const message =
      error instanceof Error
        ? error.message
        : 'Đã xảy ra lỗi không xác định trên máy chủ.';
    socket.emit('error:message', {
      code: fallbackCode,
      message,
    });
  };

  io.on('connection', (socket: TypedSocket) => {
    // 1. Tạo phòng mới
    socket.on('room:create', (payload) => {
      try {
        const { room, player } = roomManager.createRoom({
          socketId: socket.id,
          playerName: payload.playerName,
          avatar: payload.avatar,
          playerId: payload.playerId,
        });

        void socket.join(room.roomId);
        socket.emit('room:joined', {
          roomId: room.roomId,
          playerId: player.id,
        });

        roomManager.broadcastRoomState(io, room.roomId);
      } catch (error) {
        emitSocketError(socket, error, 'INVALID_INPUT');
      }
    });

    // 2. Tham gia phòng hoặc Reconnect bằng playerId
    socket.on('room:join', (payload) => {
      try {
        const { room, player, isReconnect } = roomManager.joinRoom({
          roomId: payload.roomId,
          socketId: socket.id,
          playerName: payload.playerName,
          avatar: payload.avatar,
          playerId: payload.playerId,
        });

        void socket.join(room.roomId);
        socket.emit('room:joined', {
          roomId: room.roomId,
          playerId: player.id,
        });

        roomManager.broadcastRoomState(io, room.roomId);

        // Nếu người chơi F5 kết nối lại giữa trận đấu, khôi phục thông báo pha & dữ liệu mật ban đêm
        if (isReconnect && room.phase !== 'LOBBY') {
          gameEngine.syncReconnectedPlayer(room.roomId, player.id);
        }
      } catch (error) {
        emitSocketError(socket, error, 'ROOM_NOT_FOUND');
      }
    });

    // 3. Rời phòng chủ động
    socket.on('room:leave', (payload) => {
      try {
        const found = roomManager.getPlayerBySocketId(socket.id);
        if (!found) return;

        const targetRoomId = payload.roomId || found.room.roomId;
        const { room } = roomManager.leaveRoom(targetRoomId, found.player.id);
        void socket.leave(targetRoomId);

        if (room) {
          roomManager.broadcastRoomState(io, room.roomId);
        } else {
          gameEngine.clearRoomTimer(targetRoomId);
        }
      } catch (error) {
        emitSocketError(socket, error);
      }
    });

    // 4. Chủ phòng kick người chơi
    socket.on('room:kick', (payload) => {
      try {
        const found = roomManager.getPlayerBySocketId(socket.id);
        if (!found) {
          throw new RoomManagerError(
            'PLAYER_NOT_FOUND',
            'Không tìm thấy phiên kết nối của bạn.'
          );
        }

        const { room, kickedPlayer } = roomManager.kickPlayer({
          roomId: payload.roomId,
          requesterId: found.player.id,
          targetPlayerId: payload.targetPlayerId,
        });

        io.to(kickedPlayer.socketId).emit('room:kicked', {
          roomId: room.roomId,
          reason: 'Bạn đã bị chủ phòng mời ra khỏi phòng.',
        });

        const kickedSocket = io.sockets.sockets.get(kickedPlayer.socketId);
        if (kickedSocket) {
          void kickedSocket.leave(room.roomId);
        }

        roomManager.broadcastRoomState(io, room.roomId);
      } catch (error) {
        emitSocketError(socket, error);
      }
    });

    // 5. Cập nhật cấu hình phòng (Host)
    socket.on('room:update_settings', (payload) => {
      try {
        const found = roomManager.getPlayerBySocketId(socket.id);
        if (!found) {
          throw new RoomManagerError(
            'PLAYER_NOT_FOUND',
            'Không tìm thấy phiên kết nối của bạn.'
          );
        }

        const room = roomManager.updateSettings({
          roomId: payload.roomId,
          requesterId: found.player.id,
          newSettings: payload.settings,
        });

        roomManager.broadcastRoomState(io, room.roomId);
      } catch (error) {
        emitSocketError(socket, error, 'INVALID_SETTINGS');
      }
    });

    // 6. Bắt đầu ván đấu (Host)
    socket.on('game:start', (payload) => {
      try {
        const found = roomManager.getPlayerBySocketId(socket.id);
        if (!found) {
          throw new RoomManagerError(
            'PLAYER_NOT_FOUND',
            'Không tìm thấy phiên kết nối của bạn.'
          );
        }

        gameEngine.startGame(payload.roomId, found.player.id);
      } catch (error) {
        emitSocketError(socket, error);
      }
    });

    // 7. Hành động ban đêm
    socket.on('game:night_action', (payload) => {
      try {
        const found = roomManager.getPlayerBySocketId(socket.id);
        if (!found) {
          throw new RoomManagerError(
            'PLAYER_NOT_FOUND',
            'Không tìm thấy phiên kết nối của bạn.'
          );
        }

        gameEngine.handleNightAction({
          roomId: payload.roomId,
          actorId: found.player.id,
          actionType: payload.actionType,
          targetId: payload.targetId,
        });
      } catch (error) {
        emitSocketError(socket, error);
      }
    });

    // 8. Bỏ phiếu ban ngày
    socket.on('game:vote', (payload) => {
      try {
        const found = roomManager.getPlayerBySocketId(socket.id);
        if (!found) {
          throw new RoomManagerError(
            'PLAYER_NOT_FOUND',
            'Không tìm thấy phiên kết nối của bạn.'
          );
        }

        gameEngine.handleVote({
          roomId: payload.roomId,
          voterId: found.player.id,
          targetId: payload.targetId,
        });
      } catch (error) {
        emitSocketError(socket, error);
      }
    });

    // 9. Thợ Săn bắn trả
    socket.on('game:hunter_shoot', (payload) => {
      try {
        const found = roomManager.getPlayerBySocketId(socket.id);
        if (!found) {
          throw new RoomManagerError(
            'PLAYER_NOT_FOUND',
            'Không tìm thấy phiên kết nối của bạn.'
          );
        }

        gameEngine.handleHunterShoot({
          roomId: payload.roomId,
          hunterId: found.player.id,
          targetId: payload.targetId,
        });
      } catch (error) {
        emitSocketError(socket, error);
      }
    });

    // 10. Gửi tin nhắn Chat
    socket.on('chat:send', (payload) => {
      try {
        const found = roomManager.getPlayerBySocketId(socket.id);
        if (!found) {
          throw new RoomManagerError(
            'PLAYER_NOT_FOUND',
            'Không tìm thấy phiên kết nối của bạn.'
          );
        }

        gameEngine.handleChat({
          roomId: payload.roomId,
          senderId: found.player.id,
          message: payload.message,
          channel: payload.channel,
        });
      } catch (error) {
        emitSocketError(socket, error, 'UNAUTHORIZED_CHANNEL');
      }
    });

    // 11. Ngắt kết nối
    socket.on('disconnect', () => {
      const { room } = roomManager.handleDisconnect(socket.id);
      if (room) {
        roomManager.broadcastRoomState(io, room.roomId);
      }
    });
  });
}

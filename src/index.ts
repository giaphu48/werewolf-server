import cors from 'cors';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { GameEngine } from './core/GameEngine';
import { roomManager } from './managers/RoomManager';
import { registerSocketHandlers } from './sockets/socketHandler';
import { ClientToServerEvents, ServerToClientEvents } from './types/types';

const PORT = Number(process.env.PORT) || 4000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:3000';

const app = express();
app.use(
  cors({
    origin: CLIENT_ORIGIN,
    credentials: true,
  })
);
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'werewolf-server' });
});

const httpServer = createServer(app);

const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: {
    origin: CLIENT_ORIGIN,
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

const gameEngine = new GameEngine(io, roomManager);
registerSocketHandlers(io, roomManager, gameEngine);

httpServer.listen(PORT, () => {
  console.log(`[Werewolf Server] Running on http://localhost:${PORT}`);
});

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

let rooms = {};

io.on('connection', (socket) => {
    console.log('ผู้เล่นเชื่อมต่อ:', socket.id);

    // สร้างห้อง
    socket.on('createRoom', ({ name, maxPlayers }) => {
        const roomId = Math.floor(10000 + Math.random() * 90000).toString();
        rooms[roomId] = {
            id: roomId,
            maxPlayers: parseInt(maxPlayers),
            players: [{ id: socket.id, name, isHost: true }]
        };
        socket.join(roomId);
        socket.emit('roomCreated', { roomId, room: rooms[roomId] });
    });

    // เข้าห้อง
    socket.on('joinRoom', ({ name, roomId }) => {
        const room = rooms[roomId];
        if (!room) {
            return socket.emit('errorMsg', 'หาห้องนี้ไม่พบ!');
        }
        if (room.players.length >= room.maxPlayers) {
            return socket.emit('errorMsg', 'ห้องเต็มแล้ว!');
        }

        room.players.push({ id: socket.id, name, isHost: false });
        socket.join(roomId);
        io.to(roomId).emit('updateRoom', room);
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Server UNO รันแล้วที่ http://localhost:${PORT}`);
});
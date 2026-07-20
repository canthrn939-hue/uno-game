const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

let rooms = {};

// ฟังก์ชันสร้างสำรับไพ่ UNO + ไพ่ระเบิดเวลา
function createDeck() {
    const colors = ['red', 'yellow', 'green', 'blue'];
    const values = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'Skip', 'Reverse', '+2'];
    let deck = [];

    colors.forEach(color => {
        values.forEach(val => {
            deck.push({ color, value: val });
            if (val !== '0') deck.push({ color, value: val });
        });
    });

    for (let i = 0; i < 4; i++) {
        deck.push({ color: 'black', value: 'Wild' });
        deck.push({ color: 'black', value: '+4' });
    }

    // สับไพ่
    deck.sort(() => Math.random() - 0.5);

    // 💣 2. ใส่ไพ่ระเบิดเวลาสุ่ม 1 ใบ
    const bombIndex = Math.floor(Math.random() * deck.length);
    deck[bombIndex].isBomb = true;

    return deck;
}

io.on('connection', (socket) => {
    // สร้างห้อง
    socket.on('createRoom', ({ name, maxPlayers }) => {
        const roomId = Math.floor(10000 + Math.random() * 90000).toString();
        rooms[roomId] = {
            id: roomId,
            maxPlayers: parseInt(maxPlayers),
            players: [{ id: socket.id, name, isHost: true, isReady: false, hand: [] }],
            deck: [],
            topCard: null,
            turn: 0,
            turnCount: 0,
            quickDrawClicks: []
        };
        socket.join(roomId);
        socket.emit('updateRoom', rooms[roomId]);
    });

    // เข้าห้อง
    socket.on('joinRoom', ({ name, roomId }) => {
        const room = rooms[roomId];
        if (!room) return socket.emit('errorMsg', 'ไม่พบห้องนี้');
        if (room.players.length >= room.maxPlayers) return socket.emit('errorMsg', 'ห้องเต็มแล้ว');

        room.players.push({ id: socket.id, name, isHost: false, isReady: false, hand: [] });
        socket.join(roomId);
        io.to(roomId).emit('updateRoom', room);
    });

    // ยอมรับกติกา
    socket.on('playerReady', ({ roomId, isReady }) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (player) player.isReady = isReady;
        io.to(roomId).emit('updateRoom', room);
    });

    // เริ่มเกม
    socket.on('startGame', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;

        room.deck = createDeck();
        
        // แจกไพ่สุ่มคนละ 10 ใบ
        room.players.forEach(p => {
            p.hand = room.deck.splice(0, 10);
        });

        room.topCard = room.deck.pop();
        room.turn = 0;

        startBombTimer(room);
        sendGameState(room);
        io.to(roomId).emit('gameStarted');
    });

    // ลงไพ่
    socket.on('playCard', ({ roomId, cardIndex }) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players[room.turn];
        if (player.id !== socket.id) return socket.emit('errorMsg', 'ยังไม่ถึงตาคุณ!');

        const card = player.hand[cardIndex];
        // ตรวจสอบความถูกต้องของไพ่
        if (card.color === room.topCard.color || card.value === room.topCard.value || card.color === 'black') {
            player.hand.splice(cardIndex, 1);
            room.topCard = card;

            // เอฟเฟกต์การ์ดคำสั่ง
            if (card.value === '+2' || card.value === '+4') {
                const nextPlayer = room.players[(room.turn + 1) % room.players.length];
                io.to(nextPlayer.id).emit('triggerGuess'); // 🧠 3. ทายใจสายสืบ
            }

            nextTurn(room);
        } else {
            socket.emit('errorMsg', 'ทิ้งไพ่นี้ไม่ได้!');
        }
    });

    // จั่วไพ่บังคับ 1 ใบ
    socket.on('drawCard', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players[room.turn];
        if (player.id !== socket.id) return;

        player.hand.push(room.deck.pop());
        
        // เช็คแพ้ถ้าเกิน 25 ใบ
        if (player.hand.length > 25) {
            io.to(roomId).emit('gameOver', `💥 ${player.name} ถือไพ่เกิน 25 ใบ แพ้ทันที!`);
            delete rooms[roomId];
            return;
        }

        nextTurn(room);
    });

    // 🎲 1. มินิเกม ดวลไว
    socket.on('quickDrawClick', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;
        if (!room.quickDrawClicks.includes(socket.id)) {
            room.quickDrawClicks.push(socket.id);
        }
        // เมื่อทุกคนกดครบ
        if (room.quickDrawClicks.length === room.players.length) {
            const slowestId = room.quickDrawClicks[room.quickDrawClicks.length - 1];
            const slowestPlayer = room.players.find(p => p.id === slowestId);
            slowestPlayer.hand.push(room.deck.pop(), room.deck.pop()); // จั่ว 2 ใบ
            io.to(roomId).emit('errorMsg', `😂 ${slowestPlayer.name} กดช้าสุด! โดนจั่วเพิ่ม 2 ใบ`);
            room.quickDrawClicks = [];
            sendGameState(room);
        }
    });

    // 🧠 3. ตอบคำถามทายใจ
    socket.on('answerGuess', ({ roomId, willGuess, guessedColor }) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        const nextPlayer = room.players[(room.turn + 1) % room.players.length];

        if (willGuess) {
            const hasColor = nextPlayer.hand.some(c => c.color === guessedColor);
            if (hasColor) {
                io.to(roomId).emit('errorMsg', `🎯 ${player.name} ทายถูก! ${nextPlayer.name} โดนข้ามตาทันที`);
                room.turn = (room.turn + 1) % room.players.length; // Skip
            } else {
                io.to(roomId).emit('errorMsg', `❌ ${player.name} ทายผิด! โดนทำโทษจั่วเพิ่มอีก 2 ใบ`);
                player.hand.push(room.deck.pop(), room.deck.pop());
            }
        }
        sendGameState(room);
    });
});

function nextTurn(room) {
    room.turn = (room.turn + 1) % room.players.length;
    room.turnCount++;

    // 🎲 เช็คดวลไวทุกๆ 5 ตา
    if (room.turnCount % 5 === 0) {
        room.quickDrawClicks = [];
        io.to(room.id).emit('triggerQuickDraw');
    }

    sendGameState(room);
}

// 💣 2. นับถอยหลังระเบิดเวลา 30 วินาที
function startBombTimer(room) {
    let sec = 30;
    const interval = setInterval(() => {
        sec--;
        io.to(room.id).emit('bombCountdown', sec);

        if (sec <= 0) {
            clearInterval(interval);
            // หาคนถือไพ่ระเบิด
            room.players.forEach(p => {
                const bombIdx = p.hand.findIndex(c => c.isBomb);
                if (bombIdx !== -1) {
                    p.hand.splice(bombIdx, 1);
                    for (let i = 0; i < 4; i++) p.hand.push(room.deck.pop()); // โดน +4
                    io.to(room.id).emit('errorMsg', `💥 ไพ่ระเบิดทำงานใส่ ${p.name}! โดนจั่วไป 4 ใบ`);
                }
            });
            sendGameState(room);
        }
    }, 1000);
}

function sendGameState(room) {
    room.players.forEach(p => {
        io.to(p.id).emit('updateGame', {
            currentPlayerName: room.players[room.turn].name,
            topCard: room.topCard,
            myHand: p.hand
        });
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
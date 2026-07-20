const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

let rooms = {};

function createDeck(playerCount) {
    const colors = ['red', 'yellow', 'green', 'blue'];
    const values = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'Skip', 'Reverse', '+2'];
    let deck = [];

    colors.forEach(color => {
        values.forEach(val => {
            deck.push({ color, value: val });
            if (val !== '0') deck.push({ color, value: val });
        });
    });

    for (let i = 0; i < 6; i++) {
        deck.push({ color: 'black', value: 'Wild' });
        deck.push({ color: 'black', value: '+4' });
    }

    // 💣 ไพ่ระเบิดจะถูกใส่เข้ามาเฉพาะเมื่อเล่น 4 คนขึ้นไปเท่านั้น
    if (playerCount >= 4) {
        for (let i = 0; i < 4; i++) {
            deck.push({ color: 'black', value: '💣ระเบิด' });
        }
    }

    deck.sort(() => Math.random() - 0.5);
    return deck;
}

io.on('connection', (socket) => {

    socket.on('createRoom', ({ name, maxPlayers }) => {
        const roomId = Math.floor(10000 + Math.random() * 90000).toString();
        rooms[roomId] = {
            id: roomId,
            maxPlayers: parseInt(maxPlayers) || 10,
            players: [{ id: socket.id, name, isHost: true, isReady: false, hand: [], hasDrawnThisTurn: false }],
            deck: [],
            topCard: null,
            turn: 0,
            stackedPenalty: 0,
            winnerTarget: 1,
            winners: [],
            bombClicks: [],
            turnTimerObj: null
        };
        socket.join(roomId);
        socket.emit('updateRoom', rooms[roomId]);
    });

    socket.on('joinRoom', ({ name, roomId }) => {
        const room = rooms[roomId];
        if (!room) return socket.emit('errorMsg', 'ไม่พบห้องนี้');
        if (room.players.length >= room.maxPlayers) return socket.emit('errorMsg', 'ห้องเต็มแล้ว');

        room.players.push({ id: socket.id, name, isHost: false, isReady: false, hand: [], hasDrawnThisTurn: false });
        socket.join(roomId);
        io.to(roomId).emit('updateRoom', room);
    });

    socket.on('changeName', ({ roomId, newName }) => {
        const room = rooms[roomId];
        if (!room) return;
        const p = room.players.find(x => x.id === socket.id);
        if (p) p.name = newName;
        io.to(roomId).emit('updateRoom', room);
    });

    socket.on('playerReady', ({ roomId, isReady }) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (player) player.isReady = isReady;
        io.to(roomId).emit('updateRoom', room);
    });

    socket.on('startGame', ({ roomId, winnerTarget }) => {
        const room = rooms[roomId];
        if (!room) return;

        room.winnerTarget = winnerTarget || 1;
        room.deck = createDeck(room.players.length);
        
        // แจกไพ่สุ่มคนละ 10 ใบ
        room.players.forEach(p => { p.hand = room.deck.splice(0, 10); });

        room.topCard = room.deck.pop();
        room.turn = 0;

        startTurnTimer(room);
        sendGameState(room);
        io.to(roomId).emit('gameStarted');
    });

    // ลงไพ่
    socket.on('playCard', ({ roomId, cardIndexes }) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players[room.turn];
        if (player.id !== socket.id) return socket.emit('errorMsg', 'ยังไม่ถึงตาคุณ!');

        cardIndexes.sort((a, b) => b - a);
        const cardsToPlay = cardIndexes.map(idx => player.hand[idx]);

        const firstVal = cardsToPlay[0].value;
        const allSameValue = cardsToPlay.every(c => c.value === firstVal);

        if (!allSameValue) return socket.emit('errorMsg', 'ลงพร้อมกันได้เฉพาะไพ่ที่มีเลข/คำสั่งเหมือนกันเท่านั้น!');

        const firstCard = cardsToPlay[0];
        const isValid = (firstCard.color === room.topCard.color || firstCard.value === room.topCard.value || firstCard.color === 'black');
        if (!isValid) return socket.emit('errorMsg', 'ไพ่ไม่ตรงกับใบกลางโต๊ะ!');

        // ทิ้งไพ่ออกจากมือ
        cardIndexes.forEach(idx => player.hand.splice(idx, 1));
        room.topCard = cardsToPlay[cardsToPlay.length - 1];

        // สะสมโทษ +2 / +4
        cardsToPlay.forEach(c => {
            if (c.value === '+2') room.stackedPenalty += 2;
            if (c.value === '+4') room.stackedPenalty += 4;
        });

        // กรณีลงไพ่ระเบิด! 💣
        if (firstCard.value === '💣ระเบิด') {
            room.bombClicks = [];
            // ส่งอีเวนต์ให้ทุกคน ยกเว้น คนลงไพ่ระเบิด
            room.players.forEach(p => {
                if (p.id !== player.id) io.to(p.id).emit('triggerBombEvent');
            });
            return;
        }

        if (room.topCard.color === 'black') {
            socket.emit('chooseWildColor');
        } else {
            processAfterPlay(room, player);
        }
    });

    // มินิเกมกดระเบิด
    socket.on('bombClick', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;
        if (!room.bombClicks.includes(socket.id)) room.bombClicks.push(socket.id);

        const targetCount = room.players.length - 1; // ไม่นับคนลง
        if (room.bombClicks.length === targetCount) {
            const slowestId = room.bombClicks[room.bombClicks.length - 1];
            const victim = room.players.find(p => p.id === slowestId);
            
            // โทษระเบิด +4 รวมกับโทษสะสมเดิม
            const totalPenalty = room.stackedPenalty + 4;
            for (let i = 0; i < totalPenalty; i++) victim.hand.push(room.deck.pop());

            io.to(room.id).emit('errorMsg', `💥 ${victim.name} กดระเบิดช้าสุด! รับไพ่โทษไปทั้งหมด ${totalPenalty} ใบ!`);
            room.stackedPenalty = 0;
            checkHandOverLimit(room, victim);
            nextTurn(room);
        }
    });

    socket.on('setWildColor', ({ roomId, color }) => {
        const room = rooms[roomId];
        if (!room) return;
        room.topCard.color = color;
        const player = room.players[room.turn];
        processAfterPlay(room, player);
    });

    function processAfterPlay(room, player) {
        if (player.hand.length === 1) {
            socket.emit('triggerUnoBtn', 'UNO');
        } else if (player.hand.length === 0) {
            socket.emit('triggerUnoBtn', 'WIN');
        } else {
            nextTurn(room);
        }
    }

    // ถามบลัฟ +2/+4
    socket.on('answerPlusAsk', ({ roomId, hasPlus }) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players[room.turn];

        if (hasPlus) {
            const reallyHas = player.hand.some(c => c.value === '+2' || c.value === '+4' || c.value === '💣ระเบิด');
            if (!reallyHas) {
                const totalDraw = room.stackedPenalty + 14;
                for (let i = 0; i < totalDraw; i++) player.hand.push(room.deck.pop());
                io.to(room.id).emit('errorMsg', `🤥 ${player.name} โกหก! โดนทำโทษจั่วไป ${totalDraw} ใบ!`);
                room.stackedPenalty = 0;
                checkHandOverLimit(room, player);
                nextTurn(room);
            } else {
                io.to(player.id).emit('errorMsg', 'โปรดเลือกไพ่สู้!');
            }
        } else {
            for (let i = 0; i < room.stackedPenalty; i++) player.hand.push(room.deck.pop());
            io.to(room.id).emit('errorMsg', `📥 ${player.name} ยอมรับโทษ โดนจั่วไป ${room.stackedPenalty} ใบ`);
            room.stackedPenalty = 0;
            checkHandOverLimit(room, player);
            nextTurn(room);
        }
    });

    // ปุ่ม UNO / WIN
    socket.on('unoSuccess', ({ roomId, type }) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players[room.turn];

        if (type === 'WIN') {
            room.winners.push(player.name);
            if (room.winners.length >= room.winnerTarget || room.players.length <= 1) {
                endGameShowAll(room);
                return;
            }
        }
        nextTurn(room);
    });

    socket.on('unoTimeout', ({ roomId, type }) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players[room.turn];

        if (type === 'UNO') {
            for (let i = 0; i < 4; i++) player.hand.push(room.deck.pop());
            io.to(room.id).emit('errorMsg', `⚠️ ${player.name} กด UNO ไม่ทัน! โดนทำโทษจั่ว 4 ใบ`);
        } else if (type === 'WIN') {
            for (let i = 0; i < 8; i++) player.hand.push(room.deck.pop());
            io.to(room.id).emit('errorMsg', `⚠️ ${player.name} กด UNO WIN ไม่ทัน! โดนทำโทษจั่ว 8 ใบ`);
        }
        checkHandOverLimit(room, player);
        nextTurn(room);
    });

    // ระบบการจั่วไพ่แบบใหม่
    socket.on('drawCard', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players[room.turn];

        player.hand.push(room.deck.pop());
        player.hasDrawnThisTurn = true;
        checkHandOverLimit(room, player);

        // เช็คว่ามีไพ่ลงได้หรือไม่หลังจากจั่วแล้ว
        const canPlay = player.hand.some(c => c.color === room.topCard.color || c.value === room.topCard.value || c.color === 'black');
        
        if (!canPlay) {
            io.to(room.id).emit('errorMsg', `📥 ${player.name} จั่วไพ่แล้วไม่มีใบลง ข้ามตาอัตโนมัติ`);
            nextTurn(room);
        } else {
            sendGameState(room);
        }
    });

    function nextTurn(room) {
        clearInterval(room.turnTimerObj);
        room.players[room.turn].hasDrawnThisTurn = false;
        room.turn = (room.turn + 1) % room.players.length;

        if (room.stackedPenalty > 0) {
            const nextPlayer = room.players[room.turn];
            io.to(nextPlayer.id).emit('askPlusCards');
        }

        startTurnTimer(room);
        sendGameState(room);
    }

    // เวลาเดินตาละ 40 วินาที
    function startTurnTimer(room) {
        let sec = 40;
        clearInterval(room.turnTimerObj);
        room.turnTimerObj = setInterval(() => {
            sec--;
            io.to(room.id).emit('turnTimerSec', sec);
            if (sec <= 0) {
                clearInterval(room.turnTimerObj);
                const p = room.players[room.turn];
                for (let i = 0; i < 6; i++) p.hand.push(room.deck.pop());
                io.to(room.id).emit('errorMsg', `⏰ ${p.name} ช้าเกิน 40 วินาที! โดนทำโทษจั่ว 6 ใบ`);
                checkHandOverLimit(room, p);
                nextTurn(room);
            }
        }, 1000);
    }

    // เช็คกรณีถือไพ่เกิน 25 ใบ (แพ้ทันที)
    function checkHandOverLimit(room, player) {
        if (player.hand.length > 25) {
            io.to(room.id).emit('errorMsg', `💥 ${player.name} ถือไพ่เกิน 25 ใบ (แพ้และถูกคัดออกจากเกมทันที!)`);
            room.players = room.players.filter(p => p.id !== player.id);
            
            // ถ้าเหลือแค่ 1 คน คนที่เหลือชนะทันที
            if (room.players.length === 1) {
                room.winners.push(room.players[0].name);
                endGameShowAll(room);
            } else if (room.players.length === 0) {
                endGameShowAll(room);
            }
        }
    }

    function endGameShowAll(room) {
        clearInterval(room.turnTimerObj);
        const handsData = room.players.map(p => ({ name: p.name, hand: p.hand }));
        io.to(room.id).emit('gameOverShowAll', {
            winnerNames: room.winners.length > 0 ? room.winners : ['ไม่มีผู้ชนะ'],
            playersHands: handsData
        });
        delete rooms[room.id];
    }

    // ระบบแชต
    socket.on('sendChat', ({ roomId, msg }) => {
        const room = rooms[roomId];
        if (!room) return;
        const p = room.players.find(x => x.id === socket.id);
        if (p) {
            io.to(roomId).emit('receiveChat', { sender: p.name, msg });
        }
    });

});

function sendGameState(room) {
    room.players.forEach(p => {
        io.to(p.id).emit('updateGame', {
            currentPlayerName: room.players[room.turn]?.name || '',
            topCard: room.topCard,
            stackedPenalty: room.stackedPenalty,
            myHand: p.hand
        });
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
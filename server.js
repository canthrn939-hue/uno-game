const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

let rooms = {};

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

    for (let i = 0; i < 6; i++) {
        deck.push({ color: 'black', value: 'Wild' });
        deck.push({ color: 'black', value: '+4' });
    }

    deck.sort(() => Math.random() - 0.5);

    // สุ่ม 1 ใบเป็นไพ่ระเบิด
    const bombIndex = Math.floor(Math.random() * deck.length);
    deck[bombIndex].isBomb = true;

    return deck;
}

io.on('connection', (socket) => {

    socket.on('createRoom', ({ name, maxPlayers }) => {
        const roomId = Math.floor(10000 + Math.random() * 90000).toString();
        rooms[roomId] = {
            id: roomId,
            maxPlayers: parseInt(maxPlayers) || 10,
            players: [{ id: socket.id, name, isHost: true, isReady: false, hand: [] }],
            deck: [],
            topCard: null,
            turn: 0,
            turnCount: 0,
            stackedPenalty: 0,
            winnerTarget: 1,
            winners: [],
            quickDrawClicks: [],
            turnTimerObj: null
        };
        socket.join(roomId);
        socket.emit('updateRoom', rooms[roomId]);
    });

    socket.on('joinRoom', ({ name, roomId }) => {
        const room = rooms[roomId];
        if (!room) return socket.emit('errorMsg', 'ไม่พบห้องนี้');
        if (room.players.length >= room.maxPlayers) return socket.emit('errorMsg', 'ห้องเต็มแล้ว');

        room.players.push({ id: socket.id, name, isHost: false, isReady: false, hand: [] });
        socket.join(roomId);
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
        room.deck = createDeck();
        
        // แจกไพ่สุ่มคนละ 10 ใบ
        room.players.forEach(p => { p.hand = room.deck.splice(0, 10); });

        room.topCard = room.deck.pop();
        room.turn = 0;

        startTurnTimer(room);
        startBombTimer(room);
        sendGameState(room);
        io.to(roomId).emit('gameStarted');
    });

    // ลงไพ่ (รองรับทิ้งพร้อมกันถ้าเลขเหมือนกัน)
    socket.on('playCard', ({ roomId, cardIndexes }) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players[room.turn];
        if (player.id !== socket.id) return socket.emit('errorMsg', 'ยังไม่ถึงตาคุณ!');

        cardIndexes.sort((a, b) => b - a); // ลบจากดรรชนีมากไปน้อย
        const cardsToPlay = cardIndexes.map(idx => player.hand[idx]);

        // เช็คว่าไพ่ที่จะลงพร้อมกันมีค่าตัวเลข/คำสั่งเหมือนกันทุกใบไหม
        const firstVal = cardsToPlay[0].value;
        const allSameValue = cardsToPlay.every(c => c.value === firstVal);

        if (!allSameValue) return socket.emit('errorMsg', 'ลงพร้อมกันได้เฉพาะไพ่ที่มีเลข/คำสั่งเหมือนกันเท่านั้น!');

        const firstCard = cardsToPlay[0];
        // เช็คความถูกต้องกับไพ่กลาง
        const isValid = (firstCard.color === room.topCard.color || firstCard.value === room.topCard.value || firstCard.color === 'black');
        if (!isValid) return socket.emit('errorMsg', 'ไพ่ไม่ตรงกับใบกลางโต๊ะ!');

        // ทิ้งไพ่ออกจากมือ
        cardIndexes.forEach(idx => player.hand.splice(idx, 1));
        room.topCard = cardsToPlay[cardsToPlay.length - 1]; // ใบสุดท้ายขึ้นกลาง

        // สะสมโทษ +2 / +4
        cardsToPlay.forEach(c => {
            if (c.value === '+2') room.stackedPenalty += 2;
            if (c.value === '+4') room.stackedPenalty += 4;
        });

        // เช็คการ์ดเปลี่ยนสี Wild
        if (room.topCard.color === 'black') {
            socket.emit('chooseWildColor');
        } else {
            processAfterPlay(room, player);
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
        // เช็คการกด UNO
        if (player.hand.length === 1) {
            socket.emit('triggerUnoBtn', 'UNO');
        } else if (player.hand.length === 0) {
            socket.emit('triggerUnoBtn', 'WIN');
        } else {
            nextTurn(room);
        }
    }

    // ระบบถามบลัฟ +2/+4
    socket.on('answerPlusAsk', ({ roomId, hasPlus }) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players[room.turn];

        if (hasPlus) {
            const reallyHas = player.hand.some(c => c.value === '+2' || c.value === '+4');
            if (!reallyHas) {
                // 🤥 โกหก! โดนโทษ +14 ใบ
                const totalDraw = room.stackedPenalty + 14;
                for (let i = 0; i < totalDraw; i++) player.hand.push(room.deck.pop());
                io.to(room.id).emit('errorMsg', `🤥 ${player.name} โกหก! ว่ามีไพ่บวก โดนทำโทษจั่วไป ${totalDraw} ใบ!`);
                room.stackedPenalty = 0;
                checkHandOverLimit(room, player);
                nextTurn(room);
            } else {
                io.to(player.id).emit('errorMsg', 'โปรดเลือกไพ่ +2 หรือ +4 ลงสู้!');
            }
        } else {
            // ยอมรับโทษจั่วตามปกติ
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

    // จั่วไพ่
    socket.on('drawCard', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players[room.turn];

        player.hand.push(room.deck.pop());
        checkHandOverLimit(room, player);
        nextTurn(room);
    });

    function nextTurn(room) {
        clearInterval(room.turnTimerObj);
        room.turn = (room.turn + 1) % room.players.length;
        room.turnCount++;

        // มินิเกม ดวลไว ทุก 5 ตา
        if (room.turnCount % 5 === 0) {
            room.quickDrawClicks = [];
            io.to(room.id).emit('triggerQuickDraw');
        }

        // ถ้าตาถัดไปมีการสะสมโทษ ถามบลัฟก่อน
        if (room.stackedPenalty > 0) {
            const nextPlayer = room.players[room.turn];
            io.to(nextPlayer.id).emit('askPlusCards');
        }

        startTurnTimer(room);
        sendGameState(room);
    }

    // เวลาเดิน 20 วิ
    function startTurnTimer(room) {
        let sec = 20;
        clearInterval(room.turnTimerObj);
        room.turnTimerObj = setInterval(() => {
            sec--;
            io.to(room.id).emit('turnTimerSec', sec);
            if (sec <= 0) {
                clearInterval(room.turnTimerObj);
                const p = room.players[room.turn];
                for (let i = 0; i < 6; i++) p.hand.push(room.deck.pop());
                io.to(room.id).emit('errorMsg', `⏰ ${p.name} ช้าเกิน 20 วินาที! โดนทำโทษจั่ว 6 ใบ`);
                checkHandOverLimit(room, p);
                nextTurn(room);
            }
        }, 1000);
    }

    function checkHandOverLimit(room, player) {
        if (player.hand.length > 25) {
            io.to(room.id).emit('errorMsg', `💥 ${player.name} ถือไพ่เกิน 25 ใบ (แพ้และออกจากเกมทันที!)`);
            room.players = room.players.filter(p => p.id !== player.id);
            if (room.players.length <= 1) endGameShowAll(room);
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

    // ไพ่ระเบิดเวลา
    function startBombTimer(room) {
        let sec = 30;
        const interval = setInterval(() => {
            sec--;
            io.to(room.id).emit('bombCountdown', sec);
            if (sec <= 0) {
                clearInterval(interval);
                if (!rooms[room.id]) return;
                room.players.forEach(p => {
                    const idx = p.hand.findIndex(c => c.isBomb);
                    if (idx !== -1) {
                        p.hand.splice(idx, 1);
                        for (let i = 0; i < 4; i++) p.hand.push(room.deck.pop());
                        io.to(room.id).emit('errorMsg', `💥 ไพ่ระเบิดทำงานใส่ ${p.name}! โดนจั่ว 4 ใบ`);
                    }
                });
                sendGameState(room);
            }
        }, 1000);
    }

    // Quick draw
    socket.on('quickDrawClick', ({ roomId }) => {
        const room = rooms[roomId];
        if (!room) return;
        if (!room.quickDrawClicks.includes(socket.id)) room.quickDrawClicks.push(socket.id);
        if (room.quickDrawClicks.length === room.players.length) {
            const slowestId = room.quickDrawClicks[room.quickDrawClicks.length - 1];
            const p = room.players.find(x => x.id === slowestId);
            p.hand.push(room.deck.pop(), room.deck.pop());
            io.to(roomId).emit('errorMsg', `😂 ${p.name} กดช้าสุด! โดนจั่วเพิ่ม 2 ใบ`);
            room.quickDrawClicks = [];
            sendGameState(room);
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
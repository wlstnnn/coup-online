const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public', {
    etag: false,
    lastModified: false,
    setHeaders: (res) => {
        res.setHeader('Cache-Control', 'no-store');
    }
}));


// =====================================================
// 역할
// =====================================================

const ROLES = [
    '공작', '공작', '공작',
    '암살자', '암살자', '암살자',
    '사령관', '사령관', '사령관',
    '외교관', '외교관', '외교관',
    '귀부인', '귀부인', '귀부인'
];


// =====================================================
// 행동
// =====================================================

const ACTIONS = {

    income: {
        name: '소득',
        role: null,
        cost: 0,
        target: false,
        blockRoles: [],
        blockScope: null
    },

    foreignAid: {
        name: '외부 지원',
        role: null,
        cost: 0,
        target: false,
        blockRoles: ['공작'],
        blockScope: 'any'
    },

    coup: {
        name: '쿠데타',
        role: null,
        cost: 7,
        target: true,
        blockRoles: [],
        blockScope: null
    },

    tax: {
        name: '세금 징수',
        role: '공작',
        cost: 0,
        target: false,
        blockRoles: [],
        blockScope: null
    },

    assassinate: {
        name: '암살',
        role: '암살자',
        cost: 3,
        target: true,
        blockRoles: ['귀부인'],
        blockScope: 'target'
    },

    steal: {
        name: '약탈',
        role: '사령관',
        cost: 0,
        target: true,
        blockRoles: ['사령관', '외교관'],
        blockScope: 'target'
    },

    exchange: {
        name: '교환',
        role: '외교관',
        cost: 0,
        target: false,
        blockRoles: [],
        blockScope: null
    }
};


const RESPONSE_MS = 8000;

const rooms = {};


// =====================================================
// 기본 함수
// =====================================================

function shuffle(arr) {

    const result = [...arr];

    for (
        let i = result.length - 1;
        i > 0;
        i--
    ) {

        const j =
            Math.floor(
                Math.random() * (i + 1)
            );

        [
            result[i],
            result[j]
        ] = [
            result[j],
            result[i]
        ];
    }

    return result;
}


function makePlayer(
    id,
    name,
    isAI = false
) {

    return {

        id,

        name:
            name ||
            (
                isAI
                    ? 'AI'
                    : '익명'
            ),

        isAI,

        disconnected: false,

        coins: 2,

        cards: []
    };
}


function aliveCards(player) {

    return player.cards.filter(
        card =>
            !card.dead
    );
}


function isAlive(player) {

    return (
        aliveCards(player)
            .length > 0
    );
}


function getPlayer(
    room,
    id
) {

    return room.players.find(
        player =>
            player.id === id
    );
}


function currentPlayer(room) {

    return room.players[
        room.turnIdx
    ];
}


// =====================================================
// 타이머
// =====================================================

function clearPhaseTimer(room) {

    clearTimeout(
        room.phaseTimer
    );

    room.phaseTimer =
        null;

    room.phaseDeadline =
        null;
}


function clearAITimer(room) {

    clearTimeout(
        room.aiTimer
    );

    room.aiTimer =
        null;
}


function clearAllTimers(room) {

    clearPhaseTimer(room);

    clearAITimer(room);
}


// =====================================================
// 로그
// =====================================================

function setTopLog(
    room,
    text
) {

    room.log =
        text;


    io.to(
        room.code
    ).emit(
        'log_msg',
        text
    );
}


function addHistory(
    room,
    text,
    type = 'info'
) {

    room.history.push({

        id:
            Date.now() +
            '_' +
            Math.random()
                .toString(36)
                .slice(2, 7),

        ts:
            Date.now(),

        text,

        type
    });


    if (
        room.history.length > 100
    ) {

        room.history.shift();
    }


    setTopLog(
        room,
        text
    );
}


// =====================================================
// 로비
// =====================================================

function lobbyData() {

    const data = {};


    for (
        const [code, room]
        of
        Object.entries(rooms)
    ) {

        // 끝난 방은 공개방에서 숨김
        if (
            room.closed
        ) {

            continue;
        }


        data[code] = {

            isPlaying:
                room.isPlaying,

            players:
                room.players

                    .filter(
                        player =>
                            !player.disconnected
                    )

                    .map(
                        player => ({

                            id:
                                player.id,

                            name:
                                player.name,

                            isAI:
                                player.isAI
                        })
                    )
        };
    }


    return data;
}


function broadcastLobby() {

    io.emit(
        'lobby_update',
        lobbyData()
    );
}


// =====================================================
// 대상 이름
// =====================================================

function actionTargetName(
    room,
    action
) {

    if (
        !action?.targetId
    ) {

        return null;
    }


    return getPlayer(
        room,
        action.targetId
    )?.name || null;
}


// =====================================================
// 플레이어별 프롬프트
// =====================================================

function promptFor(
    room,
    viewerId
) {

    // =================================================
    // 게임 종료
    // =================================================

    if (
        room.phase ===
        'game_over'
    ) {

        return {

            type:
                'game_over',

            winner:
                room.winner
        };
    }


    // =================================================
    // 행동 선택
    // =================================================

    if (
        room.phase ===
        'action'
    ) {

        if (
            currentPlayer(room)?.id ===
            viewerId
        ) {

            return {
                type: 'action'
            };
        }


        const active =
            currentPlayer(room);


        return {

            type:
                'wait',

            text:

                active?.isAI

                    ? `${active.name}이(가) 행동을 고민 중...`

                    : `${active?.name || '상대'}님의 턴입니다.`
        };
    }


    // =================================================
    // 행동 도전
    // =================================================

    if (
        room.phase ===
        'action_challenge'
    ) {

        const action =
            room.pendingAction;


        if (

            action.challengeIds.includes(
                viewerId
            )

            &&

            !action.passedIds.includes(
                viewerId
            )

        ) {

            const actor =
                getPlayer(
                    room,
                    action.actorId
                );


            const def =
                ACTIONS[
                    action.action
                ];


            const target =
                actionTargetName(
                    room,
                    action
                );


            return {

                type:
                    'challenge',

                title:
                    '행동에 도전하시겠습니까?',

                message:

                    `${actor.name}님이 ` +
                    `[${def.role}] 역할로 ` +
                    `${def.name}` +
                    `${target ? ` → ${target}` : ''}` +
                    `을(를) 선언했습니다.`,

                deadline:
                    room.phaseDeadline
            };
        }


        return {

            type:
                'wait',

            text:
                '다른 플레이어의 도전 여부를 기다리는 중...'
        };
    }


    // =================================================
    // 방어
    // =================================================

    if (
        room.phase ===
        'block'
    ) {

        const action =
            room.pendingAction;


        if (

            action.blockIds.includes(
                viewerId
            )

            &&

            !action.blockPassedIds.includes(
                viewerId
            )

        ) {

            const actor =
                getPlayer(
                    room,
                    action.actorId
                );


            const def =
                ACTIONS[
                    action.action
                ];


            const target =
                actionTargetName(
                    room,
                    action
                );


            return {

                type:
                    'block',

                title:
                    '방어하시겠습니까?',

                message:

                    `${actor.name}님의 ${def.name}` +
                    `${target ? ` → ${target}` : ''}` +
                    ` 행동을 막을 수 있습니다.`,

                roles:
                    def.blockRoles,

                deadline:
                    room.phaseDeadline
            };
        }


        return {

            type:
                'wait',

            text:
                '방어 여부를 기다리는 중...'
        };
    }


    // =================================================
    // 방어 도전
    // =================================================

    if (
        room.phase ===
        'block_challenge'
    ) {

        const block =
            room.pendingBlock;


        if (

            block.challengeIds.includes(
                viewerId
            )

            &&

            !block.passedIds.includes(
                viewerId
            )

        ) {

            const blocker =
                getPlayer(
                    room,
                    block.blockerId
                );


            return {

                type:
                    'challenge',

                title:
                    '방어에 도전하시겠습니까?',

                message:

                    `${blocker.name}님이 ` +
                    `[${block.role}] 역할로 방어했습니다.`,

                deadline:
                    room.phaseDeadline
            };
        }


        return {

            type:
                'wait',

            text:
                '방어에 대한 도전 여부를 기다리는 중...'
        };
    }


    // =================================================
    // 외교관 교환
    // =================================================

    if (
        room.phase ===
        'exchange'
    ) {

        if (
            room.exchange?.playerId ===
            viewerId
        ) {

            return {

                type:
                    'exchange',

                keepCount:
                    room.exchange
                        .keepCount,

                candidates:
                    room.exchange
                        .candidates
            };
        }


        return {

            type:
                'wait',

            text:

                `${getPlayer(
                    room,
                    room.exchange?.playerId
                )?.name || '플레이어'}님이 카드를 교환하는 중...`
        };
    }


    // =================================================
    // 영향력 상실
    // =================================================

    if (
        room.phase ===
        'lose'
    ) {

        if (
            room.loss.playerId ===
            viewerId
        ) {

            return {

                type:
                    'lose',

                reason:
                    room.loss.reason
            };
        }


        return {

            type:
                'wait',

            text:

                `${getPlayer(
                    room,
                    room.loss.playerId
                )?.name || '플레이어'}님이 공개할 카드를 고르는 중...`
        };
    }


    return {

        type:
            'wait',

        text:
            '처리 중...'
    };
}


// =====================================================
// 클라이언트 상태
// =====================================================

function stateFor(
    room,
    viewerId
) {

    return {

        roomCode:
            room.code,

        isPlaying:
            room.isPlaying,

        phase:
            room.phase,

        turnId:
            currentPlayer(room)?.id || null,

        log:
            room.log,

        history:
            room.history,

        players:
            room.players.map(
                player => ({

                    id:
                        player.id,

                    name:
                        player.name,

                    isAI:
                        player.isAI,

                    disconnected:
                        player.disconnected,

                    coins:
                        player.coins,

                    alive:
                        isAlive(player),

                    cards:
                        player.cards.map(
                            card => ({

                                dead:
                                    card.dead,

                                role:

                                    player.id ===
                                    viewerId

                                    ||

                                    card.dead

                                        ? card.role
                                        : null
                            })
                        )
                })
            ),

        prompt:
            promptFor(
                room,
                viewerId
            )
    };
}


function emitState(room) {

    for (
        const player
        of
        room.players
    ) {

        if (
            player.isAI
            ||
            player.disconnected
        ) {

            continue;
        }


        io.to(
            player.id
        ).emit(

            'sync_state',

            stateFor(
                room,
                player.id
            )
        );
    }


    runAI(room);
}


// =====================================================
// 승리 판정
// =====================================================

function checkWinner(room) {

    const living =

        room.players.filter(
            player =>
                isAlive(player)
        );


    if (
        living.length !== 1
    ) {

        return false;
    }


    clearAllTimers(
        room
    );


    room.phase =
        'game_over';


    room.isPlaying =
        false;


    // 공개방에서 제거
    room.closed =
        true;


    room.winner =
        living[0].name;


    addHistory(

        room,

        `🏆 ${living[0].name}님이 승리했습니다!`,

        'result'
    );


    emitState(room);

    broadcastLobby();


    return true;
}


// =====================================================
// 다음 턴
// =====================================================

function nextTurn(room) {

    clearAllTimers(
        room
    );


    if (
        checkWinner(room)
    ) {

        return;
    }


    room.pendingAction =
        null;


    room.pendingBlock =
        null;


    room.exchange =
        null;


    room.loss =
        null;


    let safety =
        0;


    do {

        room.turnIdx =

            (
                room.turnIdx + 1
            )

            %

            room.players.length;


        safety++;


        if (
            safety >
            room.players.length + 2
        ) {

            return;
        }

    }

    while (
        !isAlive(
            currentPlayer(room)
        )
    );


    room.phase =
        'action';


    addHistory(

        room,

        `▶ ${currentPlayer(room).name}님의 턴`,

        'turn'
    );


    emitState(room);
}


// =====================================================
// 영향력 상실 이후
// =====================================================

function continueAfterLoss(
    room,
    next
) {

    room.loss =
        null;


    if (
        checkWinner(room)
    ) {

        return;
    }


    if (
        next ===
        'after_action_challenge'
    ) {

        continueAfterActionChallenge(
            room
        );

        return;
    }


    if (
        next ===
        'blocked'
    ) {

        finishBlockedAction(
            room
        );

        return;
    }


    if (
        next ===
        'resolve'
    ) {

        resolveAction(
            room
        );

        return;
    }


    nextTurn(room);
}


// =====================================================
// 영향력 상실
// =====================================================

function loseInfluence(
    room,
    playerId,
    reason,
    next
) {

    const player =
        getPlayer(
            room,
            playerId
        );


    if (!player) {
        return;
    }


    const alive =
        aliveCards(player);


    if (
        !alive.length
    ) {

        continueAfterLoss(
            room,
            next
        );

        return;
    }


    // AI 또는 카드 한 장 남음
    if (
        player.isAI
        ||
        alive.length === 1
    ) {

        const card =

            player.isAI

                ? alive[
                    Math.floor(
                        Math.random() *
                        alive.length
                    )
                ]

                : alive[0];


        card.dead =
            true;


        // 사망 연출
        io.to(
            room.code
        ).emit(

            'visual_event',

            {
                type:
                    'influence_lost',

                playerId:
                    player.id,

                playerName:
                    player.name,

                role:
                    card.role,

                eliminated:
                    !isAlive(player)
            }
        );


        addHistory(

            room,

            `💥 ${player.name} → [${card.role}] 공개`,

            'loss'
        );


        continueAfterLoss(
            room,
            next
        );


        return;
    }


    // 직접 선택
    room.phase =
        'lose';


    room.loss = {

        playerId,

        reason,

        next
    };


    addHistory(

        room,

        `💥 ${player.name}님이 영향력 1개를 잃습니다.`,

        'loss'
    );


    emitState(room);
}


// =====================================================
// 역할 증명 후 교체
// =====================================================

function replaceShownRole(
    room,
    playerId,
    role
) {

    const player =
        getPlayer(
            room,
            playerId
        );


    const card =
        player?.cards.find(

            card =>
                !card.dead

                &&

                card.role ===
                role
        );


    if (!card) {
        return;
    }


    room.deck.push(
        card.role
    );


    room.deck =
        shuffle(
            room.deck
        );


    card.role =
        room.deck.pop();
}


// =====================================================
// 방어 가능 여부
// =====================================================

function hasBlocks(
    actionName
) {

    return (
        ACTIONS[
            actionName
        ].blockRoles.length > 0
    );
}


function eligibleBlockers(room) {

    const action =
        room.pendingAction;


    const def =
        ACTIONS[
            action.action
        ];


    // 암살 / 약탈
    if (
        def.blockScope ===
        'target'
    ) {

        const target =
            getPlayer(
                room,
                action.targetId
            );


        if (
            target
            &&
            isAlive(target)
        ) {

            return [
                target.id
            ];
        }


        return [];
    }


    // 외부 지원
    if (
        def.blockScope ===
        'any'
    ) {

        return room.players

            .filter(

                player =>
                    isAlive(player)

                    &&

                    player.id !==
                    action.actorId
            )

            .map(
                player =>
                    player.id
            );
    }


    return [];
}


// =====================================================
// 행동 도전 통과 후
// =====================================================

function continueAfterActionChallenge(
    room
) {

    if (
        hasBlocks(
            room.pendingAction.action
        )
    ) {

        startBlockPhase(
            room
        );

        return;
    }


    resolveAction(room);
}


// =====================================================
// 외교관 교환
// =====================================================

function startExchange(room) {

    clearAllTimers(
        room
    );


    const player =
        getPlayer(
            room,
            room.pendingAction.actorId
        );


    if (
        !player
        ||
        !isAlive(player)
    ) {

        nextTurn(room);

        return;
    }


    const liveIndices =
        [];


    player.cards.forEach(
        (
            card,
            index
        ) => {

            if (
                !card.dead
            ) {

                liveIndices.push(
                    index
                );
            }
        }
    );


    const candidates =
        [];


    // 기존 살아있는 카드
    liveIndices.forEach(
        index => {

            candidates.push({

                id:
                    `hand_${index}`,

                role:
                    player.cards[
                        index
                    ].role
            });
        }
    );


    // 덱에서 2장
    for (
        let i = 0;
        i < 2 && room.deck.length;
        i++
    ) {

        candidates.push({

            id:
                `draw_${i}`,

            role:
                room.deck.pop()
        });
    }


    room.exchange = {

        playerId:
            player.id,

        keepCount:
            liveIndices.length,

        liveIndices,

        candidates
    };


    room.phase =
        'exchange';


    addHistory(

        room,

        `🔄 ${player.name} → [외교관] 카드 교환 중`,

        'action'
    );


    emitState(room);
}


function completeExchange(
    room,
    playerId,
    selectedIds
) {

    if (
        room.phase !==
        'exchange'

        ||

        !room.exchange

        ||

        room.exchange.playerId !==
        playerId
    ) {

        return false;
    }


    if (
        !Array.isArray(
            selectedIds
        )
    ) {

        return false;
    }


    const exchange =
        room.exchange;


    const unique =
        [
            ...new Set(
                selectedIds
            )
        ];


    if (
        unique.length !==
        exchange.keepCount
    ) {

        return false;
    }


    const selected =

        unique.map(

            id =>
                exchange.candidates.find(
                    card =>
                        card.id === id
                )
        );


    if (
        selected.some(
            card =>
                !card
        )
    ) {

        return false;
    }


    const player =
        getPlayer(
            room,
            playerId
        );


    const selectedRoles =

        selected.map(
            card =>
                card.role
        );


    // 선택 안 한 카드는 덱으로 반환
    const returned =

        exchange.candidates.filter(

            card =>
                !unique.includes(
                    card.id
                )
        );


    returned.forEach(
        card => {

            room.deck.push(
                card.role
            );
        }
    );


    // 살아있는 카드 자리 교체
    exchange.liveIndices.forEach(
        (
            cardIndex,
            index
        ) => {

            player.cards[
                cardIndex
            ].role =
                selectedRoles[
                    index
                ];
        }
    );


    room.deck =
        shuffle(
            room.deck
        );


    room.exchange =
        null;


    addHistory(

        room,

        `✅ ${player.name} → 외교관 교환 완료`,

        'result'
    );


    nextTurn(room);


    return true;
}


// =====================================================
// 실제 행동 처리
// =====================================================

function resolveAction(room) {

    clearAllTimers(
        room
    );


    const action =
        room.pendingAction;


    if (!action) {
        return;
    }


    const actor =
        getPlayer(
            room,
            action.actorId
        );


    const target =

        action.targetId

            ? getPlayer(
                room,
                action.targetId
            )

            : null;


    switch (
        action.action
    ) {


        case 'income':

            actor.coins +=
                1;


            addHistory(

                room,

                `🪙 ${actor.name} → 소득 +1`,

                'coin'
            );


            nextTurn(room);

            break;


        case 'foreignAid':

            actor.coins +=
                2;


            addHistory(

                room,

                `🪙 ${actor.name} → 외부 지원 +2`,

                'coin'
            );


            nextTurn(room);

            break;


        case 'tax':

            actor.coins +=
                3;


            addHistory(

                room,

                `🪙 ${actor.name} → 공작 세금 +3`,

                'coin'
            );


            nextTurn(room);

            break;


        case 'exchange':

            startExchange(room);

            break;


        case 'steal': {

            if (
                !target
                ||
                !isAlive(target)
            ) {

                nextTurn(room);

                return;
            }


            const amount =

                Math.min(
                    2,
                    target.coins
                );


            target.coins -=
                amount;


            actor.coins +=
                amount;


            addHistory(

                room,

                `🪙 ${actor.name} → ${target.name}에게서 ${amount}코인 약탈`,

                'coin'
            );


            nextTurn(room);

            break;
        }


        case 'coup':

            if (
                !target
                ||
                !isAlive(target)
            ) {

                nextTurn(room);

                return;
            }


            addHistory(

                room,

                `💣 ${actor.name} → ${target.name}에게 쿠데타`,

                'action'
            );


            loseInfluence(

                room,

                target.id,

                '쿠데타를 당했습니다.',

                'next'
            );


            break;


        case 'assassinate':

            if (
                !target
                ||
                !isAlive(target)
            ) {

                nextTurn(room);

                return;
            }


            addHistory(

                room,

                `🗡️ ${actor.name} → ${target.name} 암살 성공`,

                'action'
            );


            loseInfluence(

                room,

                target.id,

                '암살을 당했습니다.',

                'next'
            );


            break;
    }
}


// =====================================================
// 행동 도전
// =====================================================

function startActionChallenge(room) {

    const action =
        room.pendingAction;


    const def =
        ACTIONS[
            action.action
        ];


    const actor =
        getPlayer(
            room,
            action.actorId
        );


    const target =
        actionTargetName(
            room,
            action
        );


    action.challengeIds =

        room.players

            .filter(

                player =>
                    isAlive(player)

                    &&

                    player.id !==
                    action.actorId
            )

            .map(
                player =>
                    player.id
            );


    action.passedIds =
        [];


    room.phase =
        'action_challenge';


    room.phaseDeadline =
        Date.now() +
        RESPONSE_MS;


    addHistory(

        room,

        `🎭 ${actor.name} → [${def.role}] 주장 / ${def.name}${target ? ` → ${target}` : ''}`,

        'action'
    );


    room.phaseTimer =

        setTimeout(

            () => {

                finishActionChallenge(
                    room
                );

            },

            RESPONSE_MS
        );


    emitState(room);
}


function finishActionChallenge(room) {

    if (
        room.phase !==
        'action_challenge'
    ) {

        return;
    }


    clearAllTimers(
        room
    );


    addHistory(

        room,

        `✓ 도전 없음 → ${ACTIONS[room.pendingAction.action].name} 계속 진행`,

        'pass'
    );


    continueAfterActionChallenge(
        room
    );
}


function passActionChallenge(
    room,
    playerId
) {

    if (
        room.phase !==
        'action_challenge'
    ) {

        return;
    }


    const action =
        room.pendingAction;


    if (
        !action.challengeIds.includes(
            playerId
        )

        ||

        action.passedIds.includes(
            playerId
        )
    ) {

        return;
    }


    action.passedIds.push(
        playerId
    );


    const player =
        getPlayer(
            room,
            playerId
        );


    addHistory(

        room,

        `✓ ${player.name} → 통과`,

        'pass'
    );


    if (
        action.passedIds.length ===
        action.challengeIds.length
    ) {

        finishActionChallenge(
            room
        );

        return;
    }


    emitState(room);
}


function resolveActionChallenge(
    room,
    challengerId
) {

    if (
        room.phase !==
        'action_challenge'
    ) {

        return;
    }


    clearAllTimers(
        room
    );


    const action =
        room.pendingAction;


    const actor =
        getPlayer(
            room,
            action.actorId
        );


    const challenger =
        getPlayer(
            room,
            challengerId
        );


    const role =
        ACTIONS[
            action.action
        ].role;


    if (
        !challenger

        ||

        !action.challengeIds.includes(
            challengerId
        )
    ) {

        return;
    }


    addHistory(

        room,

        `⚔️ ${challenger.name} → ${actor.name}의 [${role}] 주장에 도전!`,

        'challenge'
    );


    const truthful =

        actor.cards.some(

            card =>
                !card.dead

                &&

                card.role ===
                role
        );


    if (
        truthful
    ) {

        addHistory(

            room,

            `✅ 판정: ${actor.name}의 [${role}] 주장은 참`,

            'result'
        );


        // 도전 결과 연출
        io.to(
            room.code
        ).emit(

            'visual_event',

            {
                type:
                    'challenge_result',

                context:
                    'action',

                truthful:
                    true,

                actorName:
                    actor.name,

                challengerName:
                    challenger.name,

                role
            }
        );


        replaceShownRole(

            room,

            actor.id,

            role
        );


        loseInfluence(

            room,

            challenger.id,

            '도전에 실패했습니다.',

            'after_action_challenge'
        );
    }

    else {

        addHistory(

            room,

            `❌ 판정: ${actor.name}의 [${role}] 주장은 거짓`,

            'result'
        );


        io.to(
            room.code
        ).emit(

            'visual_event',

            {
                type:
                    'challenge_result',

                context:
                    'action',

                truthful:
                    false,

                actorName:
                    actor.name,

                challengerName:
                    challenger.name,

                role
            }
        );


        loseInfluence(

            room,

            actor.id,

            '거짓 역할 선언이 들통났습니다.',

            'next'
        );
    }
}


// =====================================================
// 방어
// =====================================================

function startBlockPhase(room) {

    clearAllTimers(
        room
    );


    const action =
        room.pendingAction;


    const ids =
        eligibleBlockers(
            room
        );


    if (
        !ids.length
    ) {

        resolveAction(room);

        return;
    }


    action.blockIds =
        ids;


    action.blockPassedIds =
        [];


    room.pendingBlock =
        null;


    room.phase =
        'block';


    room.phaseDeadline =
        Date.now() +
        RESPONSE_MS;


    setTopLog(

        room,

        `🛡️ ${ACTIONS[action.action].name} 방어 기회입니다.`
    );


    room.phaseTimer =

        setTimeout(

            () => {

                finishBlockPhase(
                    room
                );

            },

            RESPONSE_MS
        );


    emitState(room);
}


function passBlock(
    room,
    playerId
) {

    if (
        room.phase !==
        'block'
    ) {

        return;
    }


    const action =
        room.pendingAction;


    if (
        !action.blockIds.includes(
            playerId
        )

        ||

        action.blockPassedIds.includes(
            playerId
        )
    ) {

        return;
    }


    action.blockPassedIds.push(
        playerId
    );


    addHistory(

        room,

        `✓ ${getPlayer(room, playerId).name} → 방어하지 않음`,

        'pass'
    );


    if (
        action.blockPassedIds.length ===
        action.blockIds.length
    ) {

        finishBlockPhase(
            room
        );

        return;
    }


    emitState(room);
}


function finishBlockPhase(room) {

    if (
        room.phase !==
        'block'
    ) {

        return;
    }


    clearAllTimers(
        room
    );


    addHistory(

        room,

        `✓ 방어 없음 → ${ACTIONS[room.pendingAction.action].name} 처리`,

        'pass'
    );


    resolveAction(room);
}


function claimBlock(
    room,
    blockerId,
    role
) {

    if (
        room.phase !==
        'block'
    ) {

        return false;
    }


    const action =
        room.pendingAction;


    const def =
        ACTIONS[
            action.action
        ];


    if (
        !action.blockIds.includes(
            blockerId
        )

        ||

        !def.blockRoles.includes(
            role
        )
    ) {

        return false;
    }


    clearAllTimers(
        room
    );


    const blocker =
        getPlayer(
            room,
            blockerId
        );


    room.pendingBlock = {

        blockerId,

        role,

        challengeIds:

            room.players

                .filter(

                    player =>
                        isAlive(player)

                        &&

                        player.id !==
                        blockerId
                )

                .map(
                    player =>
                        player.id
                ),

        passedIds:
            []
    };


    room.phase =
        'block_challenge';


    room.phaseDeadline =
        Date.now() +
        RESPONSE_MS;


    addHistory(

        room,

        `🛡️ ${blocker.name} → [${role}] 주장 / 방어`,

        'block'
    );


    room.phaseTimer =

        setTimeout(

            () => {

                finishBlockChallenge(
                    room
                );

            },

            RESPONSE_MS
        );


    emitState(room);


    return true;
}


function passBlockChallenge(
    room,
    playerId
) {

    if (
        room.phase !==
        'block_challenge'
    ) {

        return;
    }


    const block =
        room.pendingBlock;


    if (
        !block.challengeIds.includes(
            playerId
        )

        ||

        block.passedIds.includes(
            playerId
        )
    ) {

        return;
    }


    block.passedIds.push(
        playerId
    );


    addHistory(

        room,

        `✓ ${getPlayer(room, playerId).name} → 방어 인정`,

        'pass'
    );


    if (
        block.passedIds.length ===
        block.challengeIds.length
    ) {

        finishBlockChallenge(
            room
        );

        return;
    }


    emitState(room);
}


function finishBlockChallenge(room) {

    if (
        room.phase !==
        'block_challenge'
    ) {

        return;
    }


    clearAllTimers(
        room
    );


    finishBlockedAction(
        room
    );
}


function finishBlockedAction(room) {

    const blocker =

        room.pendingBlock

            ? getPlayer(
                room,
                room.pendingBlock.blockerId
            )

            : null;


    addHistory(

        room,

        blocker

            ? `🛡️ ${blocker.name}님의 방어 성공 → 행동 취소`

            : '🛡️ 행동이 방어되었습니다.',

        'block'
    );


    nextTurn(room);
}


function resolveBlockChallenge(
    room,
    challengerId
) {

    if (
        room.phase !==
        'block_challenge'
    ) {

        return;
    }


    clearAllTimers(
        room
    );


    const block =
        room.pendingBlock;


    const blocker =
        getPlayer(
            room,
            block.blockerId
        );


    const challenger =
        getPlayer(
            room,
            challengerId
        );


    if (
        !challenger

        ||

        !block.challengeIds.includes(
            challengerId
        )
    ) {

        return;
    }


    addHistory(

        room,

        `⚔️ ${challenger.name} → ${blocker.name}의 [${block.role}] 방어에 도전!`,

        'challenge'
    );


    const truthful =

        blocker.cards.some(

            card =>
                !card.dead

                &&

                card.role ===
                block.role
        );


    if (
        truthful
    ) {

        addHistory(

            room,

            `✅ 판정: ${blocker.name}의 [${block.role}] 방어는 참`,

            'result'
        );


        io.to(
            room.code
        ).emit(

            'visual_event',

            {
                type:
                    'challenge_result',

                context:
                    'block',

                truthful:
                    true,

                actorName:
                    blocker.name,

                challengerName:
                    challenger.name,

                role:
                    block.role
            }
        );


        replaceShownRole(

            room,

            blocker.id,

            block.role
        );


        loseInfluence(

            room,

            challenger.id,

            '방어 도전에 실패했습니다.',

            'blocked'
        );
    }

    else {

        addHistory(

            room,

            `❌ 판정: ${blocker.name}의 [${block.role}] 방어는 거짓`,

            'result'
        );


        io.to(
            room.code
        ).emit(

            'visual_event',

            {
                type:
                    'challenge_result',

                context:
                    'block',

                truthful:
                    false,

                actorName:
                    blocker.name,

                challengerName:
                    challenger.name,

                role:
                    block.role
            }
        );


        loseInfluence(

            room,

            blocker.id,

            '거짓 방어가 들통났습니다.',

            'resolve'
        );
    }
}


// =====================================================
// 행동 선언
// =====================================================

function declareAction(
    room,
    actorId,
    actionName,
    targetId = null
) {

    const actor =
        getPlayer(
            room,
            actorId
        );


    const def =
        ACTIONS[
            actionName
        ];


    if (
        !room.isPlaying

        ||

        room.closed

        ||

        room.phase !==
        'action'

        ||

        !actor

        ||

        currentPlayer(room)?.id !==
        actorId

        ||

        !isAlive(actor)

        ||

        !def
    ) {

        return false;
    }


    // 10코인이면 쿠데타 강제
    if (
        actor.coins >= 10

        &&

        actionName !==
        'coup'
    ) {

        return false;
    }


    if (
        actor.coins <
        def.cost
    ) {

        return false;
    }


    let target =
        null;


    if (
        def.target
    ) {

        target =
            getPlayer(
                room,
                targetId
            );


        if (
            !target

            ||

            target.id ===
            actorId

            ||

            !isAlive(target)
        ) {

            return false;
        }
    }


    // 비용 선지불
    actor.coins -=
        def.cost;


    room.pendingAction = {

        actorId,

        action:
            actionName,

        targetId:
            def.target
                ? targetId
                : null,

        challengeIds:
            [],

        passedIds:
            [],

        blockIds:
            [],

        blockPassedIds:
            []
    };


    room.pendingBlock =
        null;


    if (
        def.role
    ) {

        startActionChallenge(
            room
        );

        return true;
    }


    addHistory(

        room,

        `▶ ${actor.name} → ${def.name}${target ? ` → ${target.name}` : ''}`,

        'action'
    );


    if (
        hasBlocks(
            actionName
        )
    ) {

        startBlockPhase(
            room
        );
    }

    else {

        resolveAction(
            room
        );
    }


    return true;
}


// =====================================================
// 사람이 나갔을 때 게임 상태 정리
// =====================================================

function resetTurnAfterDeparture(
    room,
    leavingId
) {

    clearAllTimers(
        room
    );


    // 진행 중 행동이 있었다면
    // 현재 행동을 취소.
    // 비용 행동이면 살아있는 행동자에게 비용 반환.
    if (
        room.pendingAction
    ) {

        const action =
            room.pendingAction;


        const actor =
            getPlayer(
                room,
                action.actorId
            );


        const def =
            ACTIONS[
                action.action
            ];


        if (
            actor

            &&

            actor.id !==
            leavingId

            &&

            isAlive(actor)

            &&

            def?.cost > 0
        ) {

            actor.coins +=
                def.cost;


            addHistory(

                room,

                `↩️ 플레이어 이탈로 ${actor.name}님의 진행 중 행동이 취소되어 ${def.cost}코인을 반환했습니다.`,

                'info'
            );
        }
    }


    room.pendingAction =
        null;


    room.pendingBlock =
        null;


    room.exchange =
        null;


    room.loss =
        null;


    let active =
        currentPlayer(room);


    // 현재 턴 플레이어가 나간 경우
    // 다음 생존자로 이동
    if (
        !active

        ||

        !isAlive(active)

        ||

        active.id ===
        leavingId
    ) {

        let safety =
            0;


        do {

            room.turnIdx =

                (
                    room.turnIdx + 1
                )

                %

                room.players.length;


            safety++;


            if (
                safety >
                room.players.length + 2
            ) {

                return;
            }

        }

        while (
            !isAlive(
                currentPlayer(room)
            )
        );
    }


    room.phase =
        'action';


    addHistory(

        room,

        `▶ ${currentPlayer(room).name}님의 턴`,

        'turn'
    );


    emitState(room);
}


// =====================================================
// 플레이어 나가기
// =====================================================

function removePlayerFromRoom(
    socketId,
    requestedRoomCode = null
) {

    let roomCode =
        requestedRoomCode;


    // 방코드가 없으면
    // socketId로 방 탐색
    if (
        !roomCode
    ) {

        for (
            const [code, room]
            of
            Object.entries(rooms)
        ) {

            if (
                room.players.some(
                    player =>
                        player.id ===
                        socketId
                )
            ) {

                roomCode =
                    code;

                break;
            }
        }
    }


    if (
        !roomCode
    ) {

        return;
    }


    roomCode =
        String(
            roomCode
        ).toUpperCase();


    const room =
        rooms[
            roomCode
        ];


    if (!room) {
        return;
    }


    const player =
        room.players.find(
            player =>
                player.id ===
                socketId
        );


    if (!player) {
        return;
    }


    // =================================================
    // 게임 중 이탈
    // =================================================

    if (
        room.isPlaying

        &&

        isAlive(player)
    ) {

        player.disconnected =
            true;


        // 모든 남은 영향력 상실
        player.cards.forEach(
            card => {

                if (
                    !card.dead
                ) {

                    card.dead =
                        true;
                }
            }
        );


        addHistory(

            room,

            `🚪 ${player.name}님이 게임에서 나가 탈락했습니다.`,

            'loss'
        );


        // 1명 남으면 즉시 승리
        if (
            checkWinner(room)
        ) {

            return;
        }


        // 게임 계속
        resetTurnAfterDeparture(

            room,

            socketId
        );


        broadcastLobby();

        return;
    }


    // =================================================
    // 대기실 또는 이미 끝난 방
    // =================================================

    room.players =

        room.players.filter(
            player =>
                player.id !==
                socketId
        );


    // 방장 변경
    if (
        room.hostId ===
        socketId
    ) {

        const nextHost =

            room.players.find(
                player =>
                    !player.isAI

                    &&

                    !player.disconnected
            );


        room.hostId =
            nextHost?.id ||
            null;
    }


    // =================================================
    // 실제 사람이 없으면 방 완전 삭제
    // =================================================

    const hasHuman =

        room.players.some(

            player =>
                !player.isAI

                &&

                !player.disconnected
        );


    if (
        !hasHuman
    ) {

        clearAllTimers(
            room
        );


        delete rooms[
            roomCode
        ];
    }


    broadcastLobby();
}


// =====================================================
// AI
// =====================================================

function runAI(room) {

    clearAITimer(
        room
    );


    if (
        !room.isPlaying
        ||
        room.closed
    ) {

        return;
    }


    // =================================================
    // AI 턴
    // =================================================

    if (
        room.phase ===
        'action'

        &&

        currentPlayer(room)?.isAI
    ) {

        room.aiTimer =

            setTimeout(

                () => {

                    if (
                        room.phase !==
                        'action'

                        ||

                        !room.isPlaying
                    ) {

                        return;
                    }


                    const ai =
                        currentPlayer(room);


                    if (
                        !ai?.isAI
                    ) {

                        return;
                    }


                    const targets =

                        room.players.filter(

                            player =>
                                player.id !==
                                ai.id

                                &&

                                isAlive(player)
                        );


                    let action;


                    if (
                        ai.coins >= 10
                    ) {

                        action =
                            'coup';
                    }

                    else if (
                        ai.coins >= 7

                        &&

                        Math.random() < .55
                    ) {

                        action =
                            'coup';
                    }

                    else {

                        const options = [
                            'income',
                            'foreignAid',
                            'tax',
                            'steal',
                            'exchange'
                        ];


                        if (
                            ai.coins >= 3
                        ) {

                            options.push(
                                'assassinate'
                            );
                        }


                        action =

                            options[
                                Math.floor(
                                    Math.random() *
                                    options.length
                                )
                            ];
                    }


                    const target =

                        ACTIONS[
                            action
                        ].target

                            ? targets[
                                Math.floor(
                                    Math.random() *
                                    targets.length
                                )
                            ]

                            : null;


                    declareAction(

                        room,

                        ai.id,

                        action,

                        target?.id || null
                    );

                },

                1400 +
                Math.floor(
                    Math.random() *
                    1000
                )
            );


        return;
    }


    // =================================================
    // AI 행동 도전
    // =================================================

    if (
        room.phase ===
        'action_challenge'
    ) {

        const action =
            room.pendingAction;


        const aiId =

            action.challengeIds.find(

                id => {

                    const player =
                        getPlayer(
                            room,
                            id
                        );


                    return (
                        player?.isAI

                        &&

                        !action.passedIds.includes(
                            id
                        )
                    );
                }
            );


        if (
            !aiId
        ) {

            return;
        }


        room.aiTimer =

            setTimeout(

                () => {

                    if (
                        room.phase !==
                        'action_challenge'
                    ) {

                        return;
                    }


                    if (
                        Math.random() <
                        .18
                    ) {

                        resolveActionChallenge(

                            room,

                            aiId
                        );
                    }

                    else {

                        passActionChallenge(

                            room,

                            aiId
                        );
                    }

                },

                5400 +
                Math.floor(
                    Math.random() *
                    900
                )
            );


        return;
    }


    // =================================================
    // AI 방어
    // =================================================

    if (
        room.phase ===
        'block'
    ) {

        const action =
            room.pendingAction;


        const aiId =

            action.blockIds.find(

                id => {

                    const player =
                        getPlayer(
                            room,
                            id
                        );


                    return (
                        player?.isAI

                        &&

                        !action.blockPassedIds.includes(
                            id
                        )
                    );
                }
            );


        if (
            !aiId
        ) {

            return;
        }


        room.aiTimer =

            setTimeout(

                () => {

                    if (
                        room.phase !==
                        'block'
                    ) {

                        return;
                    }


                    const ai =
                        getPlayer(
                            room,
                            aiId
                        );


                    const roles =
                        ACTIONS[
                            action.action
                        ].blockRoles;


                    const realRoles =

                        roles.filter(

                            role =>
                                ai.cards.some(

                                    card =>
                                        !card.dead

                                        &&

                                        card.role ===
                                        role
                                )
                        );


                    let willBlock;


                    if (
                        realRoles.length
                    ) {

                        willBlock =
                            Math.random() <
                            .78;
                    }

                    else {

                        willBlock =
                            Math.random() <
                            .16;
                    }


                    if (
                        willBlock
                    ) {

                        const role =

                            realRoles.length

                                ? realRoles[
                                    Math.floor(
                                        Math.random() *
                                        realRoles.length
                                    )
                                ]

                                : roles[
                                    Math.floor(
                                        Math.random() *
                                        roles.length
                                    )
                                ];


                        claimBlock(

                            room,

                            aiId,

                            role
                        );
                    }

                    else {

                        passBlock(

                            room,

                            aiId
                        );
                    }

                },

                3000 +
                Math.floor(
                    Math.random() *
                    1100
                )
            );


        return;
    }


    // =================================================
    // AI 방어 도전
    // =================================================

    if (
        room.phase ===
        'block_challenge'
    ) {

        const block =
            room.pendingBlock;


        const aiId =

            block.challengeIds.find(

                id => {

                    const player =
                        getPlayer(
                            room,
                            id
                        );


                    return (
                        player?.isAI

                        &&

                        !block.passedIds.includes(
                            id
                        )
                    );
                }
            );


        if (
            !aiId
        ) {

            return;
        }


        room.aiTimer =

            setTimeout(

                () => {

                    if (
                        room.phase !==
                        'block_challenge'
                    ) {

                        return;
                    }


                    if (
                        Math.random() <
                        .18
                    ) {

                        resolveBlockChallenge(

                            room,

                            aiId
                        );
                    }

                    else {

                        passBlockChallenge(

                            room,

                            aiId
                        );
                    }

                },

                5400 +
                Math.floor(
                    Math.random() *
                    900
                )
            );


        return;
    }


    // =================================================
    // AI 외교관 교환
    // =================================================

    if (
        room.phase ===
        'exchange'

        &&

        room.exchange
    ) {

        const ai =
            getPlayer(
                room,
                room.exchange.playerId
            );


        if (
            !ai?.isAI
        ) {

            return;
        }


        room.aiTimer =

            setTimeout(

                () => {

                    if (
                        room.phase !==
                        'exchange'

                        ||

                        !room.exchange
                    ) {

                        return;
                    }


                    const selected =

                        shuffle(
                            room.exchange
                                .candidates
                        )

                            .slice(
                                0,
                                room.exchange
                                    .keepCount
                            )

                            .map(
                                card =>
                                    card.id
                            );


                    completeExchange(

                        room,

                        ai.id,

                        selected
                    );

                },

                1800
            );
    }
}


// =====================================================
// SOCKET.IO
// =====================================================

io.on(
    'connection',

    socket => {


        socket.emit(

            'lobby_update',

            lobbyData()
        );


        socket.on(

            'request_lobby',

            () => {

                socket.emit(

                    'lobby_update',

                    lobbyData()
                );
            }
        );


        // =================================================
        // 방 생성
        // =================================================

        socket.on(

            'create_room',

            nickname => {

                let roomCode;


                do {

                    roomCode =

                        Math.random()
                            .toString(36)
                            .substring(2, 6)
                            .toUpperCase();

                }

                while (
                    rooms[
                        roomCode
                    ]
                );


                rooms[
                    roomCode
                ] = {

                    code:
                        roomCode,

                    players: [

                        makePlayer(
                            socket.id,
                            nickname
                        )
                    ],

                    deck:
                        [],

                    isPlaying:
                        false,

                    closed:
                        false,

                    phase:
                        'lobby',

                    turnIdx:
                        0,

                    hostId:
                        socket.id,

                    pendingAction:
                        null,

                    pendingBlock:
                        null,

                    exchange:
                        null,

                    loss:
                        null,

                    log:
                        '게임 시작을 기다리는 중...',

                    history:
                        [],

                    winner:
                        null,

                    phaseTimer:
                        null,

                    phaseDeadline:
                        null,

                    aiTimer:
                        null
                };


                socket.join(
                    roomCode
                );


                socket.emit(

                    'room_created',

                    {

                        roomCode,

                        players:
                            rooms[
                                roomCode
                            ].players
                    }
                );


                broadcastLobby();
            }
        );


        // =================================================
        // 참가
        // =================================================

        socket.on(

            'join_room',

            ({
                roomCode,
                nickname
            }) => {

                const code =

                    String(
                        roomCode || ''
                    )
                        .trim()
                        .toUpperCase();


                const room =
                    rooms[
                        code
                    ];


                if (
                    !room
                    ||
                    room.closed
                ) {

                    socket.emit(

                        'error_msg',

                        '없는 방입니다.'
                    );

                    return;
                }


                if (
                    room.isPlaying
                ) {

                    socket.emit(

                        'error_msg',

                        '이미 게임 중인 방입니다.'
                    );

                    return;
                }


                const activePlayers =

                    room.players.filter(
                        player =>
                            !player.disconnected
                    );


                if (
                    activePlayers.length >= 5
                ) {

                    socket.emit(

                        'error_msg',

                        '방이 가득 찼습니다.'
                    );

                    return;
                }


                room.players.push(

                    makePlayer(
                        socket.id,
                        nickname
                    )
                );


                socket.join(
                    code
                );


                io.to(
                    code
                ).emit(

                    'room_updated',

                    {

                        roomCode:
                            code,

                        players:
                            room.players
                    }
                );


                broadcastLobby();
            }
        );


        // =================================================
        // AI 추가
        // =================================================

        socket.on(

            'add_ai',

            roomCode => {

                const room =

                    rooms[
                        String(
                            roomCode || ''
                        ).toUpperCase()
                    ];


                if (
                    !room

                    ||

                    room.closed

                    ||

                    room.isPlaying

                    ||

                    room.players.length >= 5
                ) {

                    return;
                }


                if (
                    room.hostId !==
                    socket.id
                ) {

                    socket.emit(

                        'error_msg',

                        '방장만 AI를 추가할 수 있습니다.'
                    );

                    return;
                }


                const aiNumber =

                    room.players.filter(
                        player =>
                            player.isAI
                    ).length + 1;


                const aiId =

                    'ai_' +
                    Math.random()
                        .toString(36)
                        .substring(2, 8);


                room.players.push(

                    makePlayer(

                        aiId,

                        `AI ${aiNumber}`,

                        true
                    )
                );


                io.to(
                    room.code
                ).emit(

                    'room_updated',

                    {

                        roomCode:
                            room.code,

                        players:
                            room.players
                    }
                );


                broadcastLobby();
            }
        );


        // =================================================
        // 게임 시작
        // =================================================

        socket.on(

            'start_game',

            roomCode => {

                const room =

                    rooms[
                        String(
                            roomCode || ''
                        ).toUpperCase()
                    ];


                if (
                    !room
                    ||
                    room.closed
                ) {

                    return;
                }


                if (
                    room.hostId !==
                    socket.id
                ) {

                    socket.emit(

                        'error_msg',

                        '방장만 시작할 수 있습니다.'
                    );

                    return;
                }


                if (
                    room.players.length < 2
                ) {

                    socket.emit(

                        'error_msg',

                        '최소 2명이 필요합니다.'
                    );

                    return;
                }


                room.deck =
                    shuffle(
                        ROLES
                    );


                room.isPlaying =
                    true;


                room.closed =
                    false;


                room.phase =
                    'action';


                room.turnIdx =
                    0;


                room.history =
                    [];


                room.winner =
                    null;


                room.pendingAction =
                    null;


                room.pendingBlock =
                    null;


                room.exchange =
                    null;


                room.loss =
                    null;


                room.players.forEach(
                    player => {

                        player.disconnected =
                            false;


                        player.coins =
                            2;


                        player.cards = [

                            {
                                role:
                                    room.deck.pop(),

                                dead:
                                    false
                            },

                            {
                                role:
                                    room.deck.pop(),

                                dead:
                                    false
                            }
                        ];
                    }
                );


                addHistory(

                    room,

                    `🎴 게임 시작 — ${currentPlayer(room).name}님의 턴`,

                    'start'
                );


                broadcastLobby();

                emitState(room);
            }
        );


        // =================================================
        // 행동
        // =================================================

        socket.on(

            'declare_action',

            ({
                roomCode,
                action,
                targetId
            }) => {

                const room =

                    rooms[
                        String(
                            roomCode || ''
                        ).toUpperCase()
                    ];


                if (!room) {
                    return;
                }


                const success =

                    declareAction(

                        room,

                        socket.id,

                        action,

                        targetId
                    );


                if (
                    !success
                ) {

                    socket.emit(

                        'error_msg',

                        '지금은 그 행동을 할 수 없습니다. 턴과 코인을 확인해주세요.'
                    );
                }
            }
        );


        // =================================================
        // 도전
        // =================================================

        socket.on(

            'challenge_response',

            ({
                roomCode,
                challenge
            }) => {

                const room =

                    rooms[
                        String(
                            roomCode || ''
                        ).toUpperCase()
                    ];


                if (!room) {
                    return;
                }


                if (
                    room.phase ===
                    'action_challenge'
                ) {

                    if (
                        challenge
                    ) {

                        resolveActionChallenge(

                            room,

                            socket.id
                        );
                    }

                    else {

                        passActionChallenge(

                            room,

                            socket.id
                        );
                    }


                    return;
                }


                if (
                    room.phase ===
                    'block_challenge'
                ) {

                    if (
                        challenge
                    ) {

                        resolveBlockChallenge(

                            room,

                            socket.id
                        );
                    }

                    else {

                        passBlockChallenge(

                            room,

                            socket.id
                        );
                    }
                }
            }
        );


        // =================================================
        // 방어
        // =================================================

        socket.on(

            'block_response',

            ({
                roomCode,
                block,
                role
            }) => {

                const room =

                    rooms[
                        String(
                            roomCode || ''
                        ).toUpperCase()
                    ];


                if (
                    !room

                    ||

                    room.phase !==
                    'block'
                ) {

                    return;
                }


                if (
                    block
                ) {

                    const success =

                        claimBlock(

                            room,

                            socket.id,

                            role
                        );


                    if (
                        !success
                    ) {

                        socket.emit(

                            'error_msg',

                            '선택할 수 없는 방어입니다.'
                        );
                    }
                }

                else {

                    passBlock(

                        room,

                        socket.id
                    );
                }
            }
        );


        // =================================================
        // 외교관 교환
        // =================================================

        socket.on(

            'exchange_choice',

            ({
                roomCode,
                selectedIds
            }) => {

                const room =

                    rooms[
                        String(
                            roomCode || ''
                        ).toUpperCase()
                    ];


                if (!room) {
                    return;
                }


                const success =

                    completeExchange(

                        room,

                        socket.id,

                        selectedIds
                    );


                if (
                    !success
                ) {

                    socket.emit(

                        'error_msg',

                        '카드 선택이 올바르지 않습니다.'
                    );
                }
            }
        );


        // =================================================
        // 영향력 상실 카드 선택
        // =================================================

        socket.on(

            'lose_card',

            ({
                roomCode,
                cardIndex
            }) => {

                const room =

                    rooms[
                        String(
                            roomCode || ''
                        ).toUpperCase()
                    ];


                if (
                    !room

                    ||

                    room.phase !==
                    'lose'

                    ||

                    room.loss?.playerId !==
                    socket.id
                ) {

                    return;
                }


                const player =
                    getPlayer(
                        room,
                        socket.id
                    );


                const card =
                    player?.cards[
                        cardIndex
                    ];


                if (
                    !card

                    ||

                    card.dead
                ) {

                    return;
                }


                card.dead =
                    true;


                // 카드 사망 연출
                io.to(
                    room.code
                ).emit(

                    'visual_event',

                    {
                        type:
                            'influence_lost',

                        playerId:
                            player.id,

                        playerName:
                            player.name,

                        role:
                            card.role,

                        eliminated:
                            !isAlive(player)
                    }
                );


                const next =
                    room.loss.next;


                addHistory(

                    room,

                    `💥 ${player.name} → [${card.role}] 공개`,

                    'loss'
                );


                continueAfterLoss(

                    room,

                    next
                );
            }
        );


        // =================================================
        // 직접 나가기
        // =================================================

        socket.on(

            'leave_room',

            roomCode => {

                const code =

                    String(
                        roomCode || ''
                    ).toUpperCase();


                removePlayerFromRoom(

                    socket.id,

                    code
                );


                socket.leave(
                    code
                );


                socket.emit(
                    'left_room'
                );
            }
        );


        // =================================================
        // 새로고침 / 브라우저 닫기 / 인터넷 끊김
        // =================================================

        socket.on(

            'disconnect',

            () => {

                removePlayerFromRoom(
                    socket.id
                );
            }
        );
    }
);


// =====================================================
// 서버 실행
// =====================================================

const PORT =
    process.env.PORT ||
    3000;


server.listen(
    PORT,
    '0.0.0.0',
    () => {

        console.log(
            `COUP 서버 실행 중 - PORT ${PORT}`
        );
    }
);
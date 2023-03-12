const { createServer } = require("http")
const { Server } = require("socket.io");
const { createClient } = require('redis')
const base58 = require("base-58")

const client = createClient();

client.on('error', err => console.log('Redis Client Error', err));

client.connect()
    .then(() => {
        // TODO: This is also debugging garbage. Must have a feature flag/env variable to toggle
        // this.
        console.log("[DEBUG]: connected to redis")
    })

const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const httpServer = createServer();

const io = new Server(httpServer, {
    cors: {
        origin: "http://localhost:3000",
        methods: ["GET", "POST"]
    }
});

io.on("connection", (socket) => {
    setTimeout(() => pollServer(socket), 2000);

    socket.on('join-channel', function (room) {
        socket.join(room)
    })
});

const getTxData = async signature => {
    const getTxBody = { "method": "getTransaction", "jsonrpc": "2.0", "params": [signature, { "encoding": "jsonParsed", "commitment": "confirmed", "maxSupportedTransactionVersion": 0 }], "id": "56f50365-0ad4-4ff7-b1df-d8e16b0e2b97" }

    const response = await fetch('https://explorer-api.devnet.solana.com/', {
        method: 'post',
        body: JSON.stringify(getTxBody),
        headers: { 'Content-Type': 'application/json' }
    });

    const data = await response.json();
    return data
}

const pollServer = async (socket) => {
    const getSignaturesBody = { "method": "getConfirmedSignaturesForAddress2", "jsonrpc": "2.0", "params": ["88Vv88x5T9HvAxu8b1ya9KazRzcNkqkdcAU5VAH9fjkG", { "limit": 25 }], "id": "bd6f4401-a8f5-47ad-b851-9e6934de346f" };

    const response = await fetch('https://explorer-api.devnet.solana.com/', {
        method: 'post',
        body: JSON.stringify(getSignaturesBody),
        headers: { 'Content-Type': 'application/json' }
    });
    const data = await response.json();

    const value = await client.get('latest-tx-blocktime');
    if (!value) {
        await client.set("latest-tx-blocktime", data.result[0].blockTime.toString())
    }
    else {
        // TODO: We may need an env variable for debugging or a feature flag which allows us
        // to toggle this behaviour. This shall only be used for debugging, otherwise, we
        // don't need to print this garbage out everytime.
        // The following is for debugging:
        console.log("[DEBUG]:", data.result[0].blockTime)
        console.log("[DEBUG]:", parseInt(value))
        console.log("[DEBUG]: Are they different?", parseInt(value) !== data.result[0].blockTime)
        console.log("\n")

        if (parseInt(value) !== data.result[0].blockTime) {
            console.log("new notification comes in")
            const tx = await getTxData(data.result[0].signature)
            const txInstructions = tx.result.transaction.message.instructions[0]
            let channel
            try {
                channel = txInstructions.accounts[1]
            }
            catch (e) {
                console.log("[DEBUG]:", e)
                return Error("ERRORED OUT.")
            }
            const txData = txInstructions.data
            console.log("notification belongs to channel", channel)
            console.log("tx data", txData)
            const txDataDecoded = base58.decode(txData)
            let lengthOfField = 0
            let allData = []
            let index = 0
            for (let i = 0; i < txDataDecoded.length; i++) {
                let d = txDataDecoded[i]
                if (i > 7) {
                    if (i !== txDataDecoded.length - 1) {
                        console.log("[DEBUG]:", d)
                        if (d !== 0 && txDataDecoded[i + 1] === 0 && txDataDecoded[i + 2] === 0) {
                            lengthOfField = d
                        }
                        else if (d === 0 && txDataDecoded[i + 1] !== 0) {
                            let stuff = []
                            for (let j = 0; j < lengthOfField; j++) {
                                stuff.push(txDataDecoded[i + j + 1])
                            }
                            console.log("[DEBUG]:", stuff)
                            allData[index] = stuff
                            index++
                        }
                        else if (txDataDecoded[i + 1] === 0) {
                            continue
                        }
                    }
                }
            }

            const returnVal = []
            for (let k = 0; k < allData.length; k++) {
                let field = allData[k]
                field = String.fromCharCode(...field)
                console.log("[DEBUG]:", field)
                returnVal.push(field)
            }
            console.log(returnVal)
            await client.set("latest-tx-blocktime", data.result[0].blockTime)
            getTxData(data.result[0].signature)
            // Emit the event in the specific channel
            io.to(channel).emit("newNotification", {
                data: returnVal
            })
        }
        // TODO: We need to implement this correctly, currently it doesn't work. We can save
        // the latest tx block time in the db, which makes it transient. Also, we don't check for
        // multiple new transactions, and assume that only one transaction came through, since
        // the time period of 2000 ms, which is bad. We need to make this work. But this is fine
        // for now.
        /*
        Save the latest tx in the database
        And then check how many new transactions have been done since the previous latest tx
        Broadcast the information of those txs to connected nodes
        */

        // for (let i = 0; i < data.result.length; i++) {
        //     let tx = data.result[i]
        //     if (tx.blockTime > JSON.parse(value).blockTime) {
        //         console.log("brother notification aaya hai")
        //         socket.emit("newNotification", tx)
        //     }
        // }
    }
    setTimeout(() => pollServer(socket), 2000);
}

httpServer.listen(8080);
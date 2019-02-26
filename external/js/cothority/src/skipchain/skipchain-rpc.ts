import Logger from "../log";
import { IConnection, WebSocketConnection } from "../network/connection";
import { Roster } from "../network/proto";
import {
    GetAllSkipChainIDs,
    GetAllSkipChainIDsReply,
    GetSingleBlock,
    GetSingleBlockByIndex,
    GetSingleBlockByIndexReply,
    GetUpdateChain,
    GetUpdateChainReply,
    StoreSkipBlock,
    StoreSkipBlockReply,
} from "./proto";
import { SkipBlock } from "./skipblock";

/**
 * SkipchainRPC provides basic tools to interact with a skipchain
 * with a given roster
 */
export default class SkipchainRPC {
    static serviceName = "Skipchain";

    private roster: Roster;
    private conn: IConnection[];

    constructor(roster: Roster) {
        this.roster = roster;
        this.conn = roster.list.map((srvid) => {
            return new WebSocketConnection(srvid.getWebSocketAddress(), SkipchainRPC.serviceName);
        });
    }

    /**
     * Create a skipchain with a base and a max height
     *
     * @param baseHeight    base height of the skipchain
     * @param maxHeight     maximum height of the skipchain
     * @returns a promise that resolves with the genesis block
     */
    createSkipchain(baseHeight: number = 1, maxHeight: number = 3): Promise<StoreSkipBlockReply> {
        const newBlock = new SkipBlock({ roster: this.roster, maxHeight, baseHeight });
        const req = new StoreSkipBlock({ newBlock });

        return this.conn[0].send(req, StoreSkipBlockReply);
    }

    /**
     * Add a new block to a given skipchain
     * @param gid the genesis ID of the skipchain
     * @param msg the data to include in the block
     * @throws an error if the request is not successful
     */
    addBlock(gid: Buffer, msg: Buffer): Promise<StoreSkipBlockReply> {
        const newBlock = new SkipBlock({ roster: this.roster, data: msg });
        const req = new StoreSkipBlock({
            newBlock,
            targetSkipChainID: gid,
        });

        return this.conn[0].send(req, StoreSkipBlockReply);
    }

    /**
     * Get the block with the given ID
     *
     * @param bid   block ID being the hash
     * @returns a promise that resolves with the block
     */
    async getSkipBlock(bid: Buffer): Promise<SkipBlock> {
        const req = new GetSingleBlock({ id: bid });

        const block = await this.conn[0].send<SkipBlock>(req, SkipBlock);
        if (!block.computeHash().equals(block.hash)) {
            throw new Error("invalid block: hash does not match");
        }

        return block;
    }

    /**
     * Get the block by its index and the genesis block ID
     *
     * @param genesis   Genesis block ID
     * @param index     Index of the block
     * @returns a promise that resolves with the block, or reject with an error
     */
    async getSkipBlockByIndex(genesis: Buffer, index: number): Promise<GetSingleBlockByIndexReply> {
        const req = new GetSingleBlockByIndex({ genesis, index });

        const reply = await this.conn[0].send<GetSingleBlockByIndexReply>(req, GetSingleBlockByIndexReply);
        if (!reply.skipblock.computeHash().equals(reply.skipblock.hash)) {
            throw new Error("invalid block: hash does not match");
        }

        return reply;
    }

    /**
     * Get the list of known skipchains
     *
     * @returns a promise that resolves with the list of skipchain IDs
     */
    async getAllSkipChainIDs(): Promise<Buffer[]> {
        const req = new GetAllSkipChainIDs();

        const ret = await this.conn[0].send<GetAllSkipChainIDsReply>(req, GetAllSkipChainIDsReply);

        return ret.skipChainIDs.map((id) => Buffer.from(id));
    }

    /**
     * Get the shortest path to the more recent block starting from latestID
     *
     * @param latestID ID of the block
     * @returns a promise that resolves with the list of blocks
     */
    async getUpdateChain(latestID: Buffer): Promise<SkipBlock[]> {
        const req = new GetUpdateChain({ latestID });
        const ret = await this.conn[0].send<GetUpdateChainReply>(req, GetUpdateChainReply);

        const err = this.verifyChain(ret.update, latestID);
        if (err) {
            throw new Error(`invalid chain received: ${err.message}`);
        }

        return ret.update;
    }

    /**
     * Get the latest known block of the skipchain. It will follow the forward
     * links as much as possible and it is resistant to roster changes.
     *
     * @param latestID  the current latest block
     * @param roster    use a different roster than the RPC
     * @returns a promise that resolves with the block, or reject with an error
     */
    async getLatestBlock(latestID: Buffer): Promise<SkipBlock> {
        const req = new GetUpdateChain({ latestID });
        let reply: GetUpdateChainReply;

        for (const c of this.conn) {
            try {
                reply = await c.send(req, GetUpdateChainReply);
            } catch (err) {
                Logger.lvl3(`error from ${c.getURL()}: ${err.message}`);
                continue;
            }

            const err = this.verifyChain(reply.update, latestID);
            if (!err) {
                const b = reply.update.pop();

                if (b.forwardLinks.length === 0) {
                    return b;
                } else {
                    // it might happen a conode doesn't have the latest
                    // block stored so we contact the most updated
                    // roster to try to get it
                    return new SkipchainRPC(b.roster).getLatestBlock(b.hash);
                }
            } else {
                Logger.lvl3("Received corrupted skipchain with error:", err);
            }
        }

        // in theory that should not happen as at least the leader has the latest block
        throw new Error("no conode has the latest block");
    }

    /**
     * Check the given chain of blocks to insure the integrity of the
     * chain by following the forward links and verifying the signatures
     *
     * @param blocks    the chain to check
     * @param firstID   optional parameter to check the first block identity
     * @returns null for a correct chain or a detailed error otherwise
     */
    verifyChain(blocks: SkipBlock[], firstID?: Buffer): Error {
        if (blocks.length === 0) {
            // expect to have blocks
            return new Error("no block returned in the chain");
        }

        if (firstID && !blocks[0].computeHash().equals(firstID)) {
            // expect the first block to be a particular block
            return new Error("the first ID is not the one we have");
        }

        for (let i = 1; i < blocks.length; i++) {
            const prev = blocks[i - 1];
            const curr = blocks[i];

            if (!curr.computeHash().equals(curr.hash)) {
                return new Error("invalid block hash");
            }

            if (prev.forwardLinks.length === 0) {
                return new Error("no forward link included in the skipblock");
            }

            const link = prev.forwardLinks.find((l) => l.to.equals(curr.hash));
            if (!link) {
                return new Error("no forward link associated with the next block");
            }

            const err = link.verify(prev.roster.getServicePublics(SkipchainRPC.serviceName));
            if (err) {
                return new Error(`invalid link: ${err.message}`);
            }
        }

        return null;
    }
}

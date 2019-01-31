import { SIGNER, ROSTER, startConodes, BLOCK_INTERVAL } from "../support/conondes";
import ByzCoinRPC from "../../src/byzcoin/byzcoin-rpc";
import Rules from "../../src/darc/rules";
import ClientTransaction, { Instruction, Argument } from "../../src/byzcoin/client-transaction";
import CredentialsInstance, { CredentialStruct } from "../../src/byzcoin/contracts/credentials-instance";
import Signer from "../../src/darc/signer";
import Darc from "../../src/darc/darc";

async function createInstance(rpc: ByzCoinRPC, signers: Signer[], darc: Darc, cred: CredentialStruct) {
    let ctx = new ClientTransaction({
        instructions: [
            Instruction.createSpawn(
                darc.baseID,
                CredentialsInstance.contractID,
                [
                    new Argument({ name: "darcID", value: darc.baseID }),
                    new Argument({ name: "credential", value: cred.toBytes() }),
                ],
            ),
        ],
    });
    await ctx.updateCounters(rpc, signers);
    ctx.signWith(signers);

    await rpc.sendTransactionAndWait(ctx);

    return CredentialsInstance.fromByzcoin(rpc, ctx.instructions[0].deriveId());
}

describe('CredentialsInstance Tests', () => {
    const admin = SIGNER;
    const roster = ROSTER.slice(0, 4);

    beforeAll(async () => {
        await startConodes();
    });

    it('should create a credential instance', async () => {
        const darc = ByzCoinRPC.makeGenesisDarc([admin], roster);
        darc.addIdentity('spawn:credential', admin, Rules.OR);
        darc.addIdentity('invoke:credential.update', admin, Rules.OR);

        const rpc = await ByzCoinRPC.newByzCoinRPC(roster, darc, BLOCK_INTERVAL);

        const cred = new CredentialStruct();
        const ci = await createInstance(rpc, [admin], darc, cred);
        expect(ci).toBeDefined();
        expect(ci.darcID).toEqual(darc.baseID);

        // set non-existing credential
        await ci.setAttribute(admin, 'personhood', 'ed25519', admin.toBytes());
        await ci.update();
        expect(ci.getAttribute('personhood', 'ed25519')).toEqual(admin.toBytes());

        // set a different credential
        await ci.setAttribute(admin, 'personhood', 'abc', Buffer.from('abc'));
        await ci.update();
        expect(ci.getAttribute('personhood', 'ed25519')).toEqual(admin.toBytes());
        expect(ci.getAttribute('personhood', 'abc')).toEqual(Buffer.from('abc'));

        // update a credential
        await ci.setAttribute(admin, 'personhood', 'abc', Buffer.from('def'));
        await ci.update();
        expect(ci.getAttribute('personhood', 'ed25519')).toEqual(admin.toBytes());
        expect(ci.getAttribute('personhood', 'abc')).toEqual(Buffer.from('def'));

        expect(ci.getAttribute('personhood', 'a')).toBeNull();
        expect(ci.getAttribute('a', '')).toBeNull();
    });
});

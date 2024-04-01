import * as web3 from '@solana/web3.js';
import { exec } from 'child_process';


const connection = new web3.Connection(web3.clusterApiUrl('mainnet-beta'));

async function getActivationEpochFromCurl(stakeAccount: web3.PublicKey) {

    function executeSolanaCommand(command: string): Promise<any> {
        return new Promise((resolve, reject) => {
            exec(command, (error, stdout, stderr) => {
                if (error) {
                    reject(error);
                    return;
                }
                if (stderr) {
                    reject(new Error(stderr));
                    return;
                }
                try {
                    const data = JSON.parse(stdout);
                    resolve(data);
                } catch (parseError) {
                    reject(parseError);
                }
            });
        });
    }
    try {
        const result = await executeSolanaCommand(`solana stake-account -um ${stakeAccount.toBase58()} --output json`);
        const activationEpoch = result['activationEpoch'];
        return activationEpoch
    } catch (error) {
        console.error('Error:', error);
    }
}

function getCalendarDaysDifference(timestamp1: number, timestamp2: number): number {
    // Convert Unix timestamps to Date objects
    const date1 = new Date(timestamp1 * 1000);
    const date2 = new Date(timestamp2 * 1000);

    // Calculate the difference in milliseconds
    const differenceMs = Math.abs(date1.getTime() - date2.getTime());

    // Convert milliseconds to days
    const differenceDays = differenceMs / (1000 * 60 * 60 * 24);

    return differenceDays;
}

async function fetchStakeAccountsPubKeys(wallets: string[]): Promise<web3.PublicKey[]> {
    const stakeAccounts: web3.PublicKey[] = [];

    for (const wallet of wallets) {
        try {
            const stakeAccountsResponse = await connection.getProgramAccounts(new web3.PublicKey("Stake11111111111111111111111111111111111111"), {
                filters: [
                    { memcmp: { offset: 12, bytes: wallet } }
                ]
            });
            stakeAccounts.push(...stakeAccountsResponse.map(data => data.pubkey));
        } catch(e) {
            console.log("wtf")
            console.log(e)
        }

    }
    return stakeAccounts;
}

async function calculateRewardForAccountConstant(stakeAccount: web3.PublicKey, activationEpoch: number): Promise<number> {
    const currentBalance = await connection.getBalance(stakeAccount)

    const activationInflationRewards = await connection.getInflationReward([stakeAccount], activationEpoch + 1)
    const rewardsAtActivationEpoch = activationInflationRewards[0]?.amount;
    if(!rewardsAtActivationEpoch) {
        console.log("No rewards at provided activation epoch.")
        return 0;
    }
    const postAccountBalanceAtActivationEpoch = activationInflationRewards[0]?.postBalance
    if(!postAccountBalanceAtActivationEpoch) {
        console.log("No post balance for account at activation epoch. Cannot calcualte reward")
        return 0;
    }
    const initialDelegation = postAccountBalanceAtActivationEpoch - rewardsAtActivationEpoch;

    const stakedRewards = currentBalance - initialDelegation;
    return stakedRewards / (10**9)
}

// This was a test to iterate through all the epochs - but it gave the same result as the constant soln
// Ofc this is slow af
async function calculateRewardForAccountIteration(stakeAccount: web3.PublicKey, activationEpoch: number) {
    let totalRewardSol = 0;
    const currentEpoch = await (await connection.getEpochInfo()).epoch;
    console.log(activationEpoch);
    const activationEpochRewardInfo = await connection.getInflationReward([stakeAccount], activationEpoch + 1);
    const activationSlot = activationEpochRewardInfo[0]?.effectiveSlot;
    console.log(activationEpochRewardInfo);
    console.log(activationSlot)
    if(!activationSlot) {
        throw new Error("Cannot fetch activation slot");
    }
    const activationRewardTime = await connection.getBlockTime(activationSlot)
    let prevEpochRewardTime = activationRewardTime;

    let epochCounter = activationEpoch + 2;
    while(epochCounter < currentEpoch) {
        console.log(`Current Epoch: ${epochCounter}`)
        const currentEpochRewardInfo = await connection.getInflationReward([stakeAccount], epochCounter);
        if(!currentEpochRewardInfo[0]) {
            console.log("No reward info for epoch")
            continue;
        }
        const currentEpochSlot = currentEpochRewardInfo[0].effectiveSlot;

        const currentEpochRewardTime = await connection.getBlockTime(currentEpochSlot)
        if(prevEpochRewardTime && currentEpochRewardTime) {
            const epochCalenderDays = getCalendarDaysDifference(prevEpochRewardTime, currentEpochRewardTime)
            console.log(`Epoch calender days - ${epochCalenderDays}`);
        } else {
            console.log(`No time available for epoch ${currentEpoch}`)
        }
        
        
        const rewardAtEpochLamports = currentEpochRewardInfo[0]?.amount;
        if(rewardAtEpochLamports) {
            console.log(`${rewardAtEpochLamports / (10 ** 9)} SOL`)
        }
        epochCounter += 1;
        prevEpochRewardTime = currentEpochRewardTime
        console.log("")
    }
    return totalRewardSol;
}

async function runCalculateRewardsForAllAccounts(stakeAccounts: web3.PublicKey[]): Promise<number> {
    let netRewardsSol = 0;
    for (const account of stakeAccounts) {
        const activationEpoch = await getActivationEpochFromCurl(account);
        if(activationEpoch) {
            const totalRewardForAccountSol = await calculateRewardForAccountIteration(account, activationEpoch)
            netRewardsSol += totalRewardForAccountSol;
        } else {
            console.log(`Skipping stake account ${account}, probably never delegated`);
        }
    }
    return netRewardsSol;
}

async function main() {
    if (process.argv.length < 3) {
        console.log("Usage: ts-node script.ts <wallet1> <wallet2>");
        process.exit(1);
    }

    const wallets = process.argv.slice(2);

    const stakingAccountsWithPubKeys = await fetchStakeAccountsPubKeys(wallets)
    const rewards = await runCalculateRewardsForAllAccounts(stakingAccountsWithPubKeys);
    console.log(`Net rewards: ${rewards} SOL`);
}

main().catch(console.error);


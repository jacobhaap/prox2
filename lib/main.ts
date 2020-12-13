import crypto from 'crypto';

import Airtable from 'airtable';
import { WebClient } from '@slack/web-api';
import body_parser from 'body-parser';

import { NextApiRequest, NextApiResponse, PageConfig } from 'next';

import { token, airtable_api_key, airtable_base, staging_channel, confessions_channel, slack_signing_secret } from '../secrets';

export const api_config = {
    api: {
        bodyParser: false
    }
} as PageConfig;

function applyMiddleware<T>(
    req: NextApiRequest, res: NextApiResponse,
    fn: (arg0: any, arg1: any, cb: (arg0: T) => void) => T
): Promise<T> {
    return new Promise((resolve, reject) => {
        fn(req, res, (result) => {
            if (result instanceof Error) {
                return reject(result)
            }

            return resolve(result)
        })
    })
}

function rawbody_verify(req: any, _res: any, buf: any, encoding: any) {
    if (buf && buf.length) {
        req.rawBody = buf.toString(encoding || 'utf8')
    }
}

const parsers = [
    body_parser.urlencoded({
        verify: rawbody_verify,
        extended: false
    }),
    body_parser.json({
        verify: rawbody_verify
    })
];

export async function setupMiddlewares(req: NextApiRequest, res: NextApiResponse) {
    for (const parser of parsers) {
        await applyMiddleware(req, res, parser);
    }
}

export const web = new WebClient(token);

Airtable.configure({
    endpointUrl: 'https://api.airtable.com',
    apiKey: airtable_api_key,
    apiVersion: Airtable.apiVersion,
    noRetryIfRateLimited: Airtable.noRetryIfRateLimited
});

export const base = Airtable.base(airtable_base);
export const table = base.table('Main');

export interface CommandData {
    token?: string;
    command: string;
    text: string;
    response_url: string;
    trigger_id: string;
    user_id: string;
    user_name?: string;
    team_id: string;
    enterprise_id?: string;
    channel_id: string;
    api_app_id: string;
};

export function isCommandData(x: any): x is CommandData {
    return (x.token == undefined || typeof x.token == 'string')
        && typeof x.command == 'string'
        && typeof x.text == 'string'
        && typeof x.response_url == 'string'
        && typeof x.trigger_id == 'string'
        && typeof x.user_id == 'string'
        && (x.user_name == undefined || typeof x.user_name == 'string')
        && typeof x.team_id == 'string'
        && (x.enterprise_id == undefined || typeof x.enterprise_id == 'string')
        && typeof x.channel_id == 'string'
        && typeof x.api_app_id == 'string';
}

export interface TableRecord {
    id: number;
    approved: boolean;
    viewed: boolean;
    text: string;
    staging_ts: string;
    published_ts: string;
    uid_salt: string;
    uid_hash: string;
};

export async function validateData(req: NextApiRequest): Promise<CommandData | null> {
    if (!isCommandData(req.body)) {
        return null;
    } else {
        return req.body;
    }
}

export async function failRequest(response_url: string, error: string) {
    console.log(`Failing with error: ${error}`);
    await fetch(response_url, {
        method: 'POST',
        body: JSON.stringify({
            response_type: 'ephemeral',
            text: error
        })
    });
}

export async function succeedRequest(response_url: string, message: string) {
    console.log(`Succeeding with message: ${message}`);
    await fetch(response_url, {
        method: 'POST',
        body: JSON.stringify({
            response_type: 'ephemeral',
            text: message
        })
    });
}

function hashUser(uid: string, salt: string): string {
    return crypto.scryptSync(Buffer.from(uid), salt, 64).toString('hex');
}

export function sameUser(fields: TableRecord, uid: string): boolean {
    const new_uid_hash = hashUser(uid, fields.uid_salt);
    return crypto.timingSafeEqual(Buffer.from(fields.uid_hash), Buffer.from(new_uid_hash));
}

export async function stageConfession(message: string, uid: string): Promise<void> {
    console.log(`Staging confession...`);
    console.log(`Creating new UID salt...`);
    const uid_salt = crypto.randomBytes(16).toString('hex');
    console.log(`Hashing UID...`);
    const uid_hash = hashUser(uid, uid_salt);
    console.log(`Salt = ${uid_salt} hashed = ${uid_hash}`);
    console.log(`Inserting into Airtable...`);
    let record;
    try {
        record = await table.create({
            text: message,
            approved: false,
            uid_salt,
            uid_hash,
        } as Partial<TableRecord>);
    } catch (_) {
        throw 'Failed to insert Airtable record';
    }
    console.log(`Inserted!`);
    console.log(`Posting message to staging channel...`);
    const fields = record.fields as TableRecord;
    const staging_message = await web.chat.postMessage({
        channel: staging_channel,
        text: '',
        blocks: [
            {
                type: "section",
                text: {
                    type: "mrkdwn",
                    text: `(staging) *${fields.id}*: ${fields.text}`
                }
            },
            {
                type: "actions",
                elements: [
                    {
                        type: "button",
                        text: {
                            type: "plain_text",
                            text: ":true: Approve",
                            emoji: true
                        },
                        value: "approve",
                        action_id: "approve"
                    },
                    {
                        type: "button",
                        text: {
                            type: "plain_text",
                            text: ":x: Disapprove",
                            emoji: true
                        },
                        value: "disapprove",
                        action_id: "disapprove"
                    },
                    {
                        type: "button",
                        text: {
                            type: "plain_text",
                            text: "Open in browser",
                            emoji: true
                        },
                        value: "open-in-browser",
                        action_id: "open-in-browser"
                    }
                ]
            }
        ]
    });
    if (!staging_message.ok) {
        console.log(`Failed to post message. Rolling back Airtable record...`);
        await record.destroy();
        console.log(`Rolled back changes. Notifying user...`);
        throw 'Failed to post message to staging channel';
    }
    console.log(`Posted message!`);
    console.log(`Updating Airtable record...`);
    try {
        await record.patchUpdate({
            staging_ts: staging_message.ts as string,
        } as Partial<TableRecord>);
    } catch (_) {
        throw 'Failed to update Airtable record';
    }
    console.log(`Updated!`);
}

export async function viewConfession(staging_ts: string, approved: boolean): Promise<void> {
    console.log(`${approved ? 'Approving' : 'Disapproving'} confession with staging_ts=${staging_ts}...`);
    // Check if message is in Airtable
    let records;
    try {
        records = await (await table.select({
            filterByFormula: `{staging_ts} = ${staging_ts}`
        })).firstPage();
    } catch (_) {
        throw `Failed to fetch Airtable record!`;
    }
    if (records.length == 1) {
        const record = records[0];
        const fields = record.fields as TableRecord;
        // Publish record and update
        let ts = null;
        if (approved) {
            console.log(`Publishing message...`);
            const published_message = await web.chat.postMessage({
                channel: confessions_channel,
                text: `*${fields.id}*: ${fields.text}`
            });
            if (!published_message.ok) {
                throw `Failed to publish message!`;
            }
            ts = published_message.ts as string;
            console.log(`Published message!`);
        }
        console.log(`Updating Airtable record...`);
        try {
            await record.patchUpdate({
                approved,
                viewed: true,
                published_ts: ts
            } as Partial<TableRecord>);
        } catch (_) {
            throw `Failed to update Airtable record`;
        }
        console.log(`Updated!`);
        console.log(`Deleting staging message...`);
        try {
            await web.chat.delete({
                channel: staging_channel,
                ts: staging_ts
            });
        } catch (_) {
            throw `Failed to delete staging message`;
        }
        console.log(`Deleted!`);
    } else {
        throw `Failed to find single record with staging_ts=${staging_ts}, got ${records.length}`;
    }
}

export function verifySignature(req: NextApiRequest): boolean {
    const timestamp = req.headers['x-slack-request-timestamp'];
    if (timestamp == undefined || typeof timestamp != 'string') {
        console.log(`Invalid X-Slack-Request-Timestamp`);
        return false;
    }
    const timestamp_int = parseInt(timestamp, 10);
    const current_timestamp_int = Math.floor(Date.now() / 1000);
    if (Math.abs(current_timestamp_int - timestamp_int) > 60 * 5) {
        // >5min, invalid (possibly replay attack)
        console.log(`Timestamp is more than 5 minutes from local time, possible replay attack!`);
        console.log(`Our timestamp was ${current_timestamp_int}; theirs was ${timestamp_int}`);
        return false;
    }
    const sig_base = 'v0:' + timestamp + ':' + (req as unknown as { rawBody: string }).rawBody;
    const my_sig = 'v0=' + crypto.createHmac('sha256', slack_signing_secret)
        .update(sig_base)
        .digest('hex');
    const slack_sig = req.headers['x-slack-signature'];
    if (slack_sig == 'undefined' || typeof slack_sig != 'string') {
        console.log(`Invalid X-Slack-Signature`);
        return false;
    }
    if (!crypto.timingSafeEqual(Buffer.from(my_sig), Buffer.from(slack_sig))) {
        console.log(`Signatures do not match`);
        return false;
    }
    return true;
}
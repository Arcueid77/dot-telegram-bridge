import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readPrivateFile} from '@dot-bridge/core/platform/private-files.js';
import {assertPairingDestination,writePairedCredentials} from '@dot-bridge/core/channels/pairing.js';
import {createOwnerPairing} from '../src/pairing.js';

export async function runPairOwner(args, {read=readPrivateFile, write=writePairedCredentials, pairing=createOwnerPairing, exists=file=>fs.existsSync(file), assertDestination=assertPairingDestination, output=value=>process.stdout.write(value+'\n'), signal} = {}) {
  const options={};
  for(let i=0;i<args.length;i++) {
    const key=args[i];
    if(!['--token-file','--credentials-file','--confirm-stopped','--confirm-private-storage'].includes(key) || options[key]!==undefined)throw new Error('Pairing arguments are invalid.');
    options[key]=key.startsWith('--confirm-')?true:args[++i];
  }
  if(!options['--confirm-stopped'] || !options['--confirm-private-storage'])throw new Error('Confirm the old consumer is stopped and approve private credential storage before pairing.');
  const tokenFile=options['--token-file'],destination=options['--credentials-file'];
  if(typeof tokenFile!=='string'||typeof destination!=='string'||!path.isAbsolute(tokenFile)||!path.isAbsolute(destination)||path.normalize(tokenFile)!==tokenFile||path.normalize(destination)!==destination||tokenFile===destination)throw new Error('Use separate absolute private token and credentials paths.');
  if(exists(destination))throw new Error('Existing credentials are preserved; use the existing binding or plan an explicit migration.');
  assertDestination(destination);
  const bytes=read(tokenFile,{maxBytes:256});
  let botToken;
  try{botToken=bytes.toString('utf8').replace(/\r?\n$/,'');}finally{bytes.fill(0);}
  const session=await pairing({botToken,confirmStopped:true,signal});
  output('Send this exact command to your dedicated bot in your own Telegram private chat within 2 minutes:');
  output(session.command);
  const credentials=await session.waitForOwner();
  if(signal?.aborted || Date.now() >= session.expiresAt)throw new Error('Pairing expired or was cancelled; credentials were not saved.');
  if(exists(destination))throw new Error('Existing credentials are preserved.');
  write(destination,credentials);
  output('Owner pairing verified. Private credentials saved: '+destination);
  return {paired:true,credentialsSaved:true};
}

if(process.argv[1] && fileURLToPath(import.meta.url)===path.resolve(process.argv[1])) {
  const controller=new AbortController();const cancel=()=>controller.abort();process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
  try{await runPairOwner(process.argv.slice(2),{signal:controller.signal});}
  catch(error){
    const known=new Set(['confirm_stopped_required','invalid_token','bot_token_rejected','another_consumer_or_webhook','bot_identity_mismatch','existing_webhook_preserved','telegram_response_invalid','telegram_request_failed','pairing_expired','pairing_cancelled','ambiguous_pairing_messages','pending_updates_require_review']);
    process.stderr.write('Telegram pairing incomplete'+(known.has(error?.reason)?': '+error.reason:'; check flags, protected paths and existing credentials')+'.\n');process.exitCode=1;
  } finally {process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);}
}

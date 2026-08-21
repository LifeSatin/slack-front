import { App } from '@slack/bolt';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { BackendClient } from './clients/backend.js';
import { StompClient } from './clients/stomp.js';
import { NegotiationService } from './services/negotiation.js';
import { registerMeetu } from './commands/meetu.js';

const config=loadConfig();
const store=new Store(config.DATABASE_PATH);
let app:App;
const customRoutes=[
  {path:'/healthz',method:'GET',handler:(_req:any,res:any)=>res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({ok:true}))}
];
app=new App({token:config.SLACK_BOT_TOKEN,signingSecret:config.SLACK_SIGNING_SECRET,socketMode:config.SLACK_SOCKET_MODE,appToken:config.SLACK_APP_TOKEN,customRoutes});
const backend=new BackendClient(config.BACKEND_BASE_URL,config.BACKEND_SERVICE_TOKEN);
const negotiation=new NegotiationService(store,backend,app.client,(userId,handlers)=>new StompClient(config.BACKEND_WS_URL,userId,config.BACKEND_SERVICE_TOKEN,handlers),config.MESSAGE_CONFIRM_TIMEOUT_MS);
registerMeetu(app,{store,backend,negotiation,allowedTeamId:config.SLACK_TEAM_ID});

if(config.SLACK_SOCKET_MODE)await app.start();else await app.start(config.PORT);
for(const active of store.listActive()){const user=store.getUser(active.teamId,active.requesterSlackUserId);if(user)negotiation.ensureStomp(user.internalUserId);}
console.log(`Meet:U Slack bot started (${config.SLACK_SOCKET_MODE?'Socket Mode':'HTTP Events API'})`);
const shutdown=async()=>{await negotiation.stop();store.close();await app.stop();};process.on('SIGINT',()=>void shutdown());process.on('SIGTERM',()=>void shutdown());

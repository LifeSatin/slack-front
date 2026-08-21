import test from 'node:test';
import assert from 'node:assert/strict';
import { registerMeetu } from '../src/commands/meetu.js';
import { Store } from '../src/store.js';

test('/meetu connect exposes the URL issued by Spring',async()=>{
  let commandHandler:any;
  const app={command:(_name:string,handler:any)=>{commandHandler=handler;},action:()=>{}} as any;
  const store=new Store(':memory:');
  const calls:Array<[string,string]>=[];
  const backend={
    createSlackOAuthLink:async(teamId:string,slackUserId:string)=>{
      calls.push([teamId,slackUserId]);
      return {connectUrl:'https://backend.example/api/slack/oauth/connect?state=spring-issued',expiresAt:'2026-08-20T00:10:00Z'};
    }
  } as any;
  const responses:any[]=[];
  try{
    registerMeetu(app,{store,backend,negotiation:{} as any});
    await commandHandler({
      command:{team_id:'T123',user_id:'U456',channel_id:'C789',channel_name:'general',trigger_id:'trigger',text:'connect'},
      ack:async()=>{},
      respond:async(response:any)=>{responses.push(response);},
      client:{}
    });
    assert.deepEqual(calls,[['T123','U456']]);
    assert.equal(responses.length,1);
    assert.equal(responses[0].blocks[1].elements[0].url,'https://backend.example/api/slack/oauth/connect?state=spring-issued');
  }finally{store.close();}
});

test('/meetu status synchronizes a completed Spring link into the bot store',async()=>{
  let commandHandler:any;
  const app={command:(_name:string,handler:any)=>{commandHandler=handler;},action:()=>{}} as any;
  const store=new Store(':memory:');
  const backend={getSlackOAuthLink:async()=>({connected:true,userId:7,name:'MeetU User',linkedAt:'2026-08-20T00:00:00Z'})} as any;
  const responses:any[]=[];
  try{
    registerMeetu(app,{store,backend,negotiation:{} as any});
    await commandHandler({
      command:{team_id:'T123',user_id:'U456',channel_id:'C789',channel_name:'general',trigger_id:'trigger',text:'status'},
      ack:async()=>{},respond:async(response:any)=>{responses.push(response);},client:{}
    });
    assert.equal(store.getUser('T123','U456')?.internalUserId,7);
    assert.match(responses[0].text,/계정: 연결됨/);
  }finally{store.close();}
});

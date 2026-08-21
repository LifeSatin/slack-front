import test from 'node:test';
import assert from 'node:assert/strict';
import { BackendClient } from '../src/clients/backend.js';

test('requests a Spring-issued Slack OAuth link with the dedicated service header',async()=>{
  const original=globalThis.fetch;
  let captured: {url:string;init?:RequestInit}|undefined;
  globalThis.fetch=async(input,init)=>{
    captured={url:String(input),init};
    return new Response(JSON.stringify({connectUrl:'https://backend.example/api/slack/oauth/connect?state=opaque',expiresAt:'2026-08-20T00:10:00Z'}),{status:201,headers:{'content-type':'application/json'}});
  };
  try{
    const client=new BackendClient('https://backend.example','shared-secret');
    const result=await client.createSlackOAuthLink('T123','U456');
    assert.equal(result.connectUrl,'https://backend.example/api/slack/oauth/connect?state=opaque');
    assert.equal(captured?.url,'https://backend.example/api/slack/oauth/links');
    assert.equal(captured?.init?.method,'POST');
    assert.equal(new Headers(captured?.init?.headers).get('X-Slack-Service-Token'),'shared-secret');
    assert.deepEqual(JSON.parse(String(captured?.init?.body)),{teamId:'T123',slackUserId:'U456'});
  }finally{globalThis.fetch=original;}
});

test('reads the Spring Slack link status',async()=>{
  const original=globalThis.fetch;
  let requested='';
  globalThis.fetch=async(input)=>{
    requested=String(input);
    return new Response(JSON.stringify({connected:true,userId:7,name:'MeetU User',linkedAt:'2026-08-20T00:00:00Z'}),{status:200,headers:{'content-type':'application/json'}});
  };
  try{
    const client=new BackendClient('https://backend.example','shared-secret');
    const result=await client.getSlackOAuthLink('T123','U456');
    assert.equal(requested,'https://backend.example/api/slack/oauth/links/T123/U456');
    assert.equal(result.connected,true);
    assert.equal(result.userId,7);
  }finally{globalThis.fetch=original;}
});

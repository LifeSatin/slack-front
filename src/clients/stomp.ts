import { Client, type IMessage } from '@stomp/stompjs';
import WebSocket from 'ws';
import type { AgentEvent, ChatMessage, NegotiationEvent, StompError } from '../types/contracts.js';

type Handlers = { message:(v:ChatMessage)=>void; negotiation:(v:NegotiationEvent)=>void; agent:(v:AgentEvent)=>void; error:(v:StompError)=>void; connection:(connected:boolean)=>void };
export class StompClient {
  private client?: Client; private reconnectAttempt=0; private pending = new Map<string,{resolve:(m:ChatMessage)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}>();
  constructor(private url:string,private userId:number,private serviceToken:string|undefined,private handlers:Handlers) {}
  start() {
    this.client = new Client({ webSocketFactory:()=>new WebSocket(this.url) as any, connectHeaders:{userId:String(this.userId),...(this.serviceToken?{serviceToken:this.serviceToken}:{})}, heartbeatIncoming:10000,heartbeatOutgoing:10000,reconnectDelay:1000,connectionTimeout:10000 });
    this.client.onConnect=()=>{ this.reconnectAttempt=0;this.client!.reconnectDelay=1000;this.handlers.connection(true); this.subscribe('/user/queue/chat/messages',(v:ChatMessage)=>{ const p=this.pending.get(v.clientMessageId); if(p){clearTimeout(p.timer);this.pending.delete(v.clientMessageId);p.resolve(v);} this.handlers.message(v); }); this.subscribe('/user/queue/chat/negotiations',this.handlers.negotiation); this.subscribe('/user/queue/chat/agent-events',this.handlers.agent); this.subscribe('/user/queue/chat/errors',this.handlers.error); };
    this.client.onWebSocketClose=()=>{this.reconnectAttempt++;const cap=Math.min(30000,1000*2**Math.min(this.reconnectAttempt,5));this.client!.reconnectDelay=Math.round(cap/2+Math.random()*cap/2);this.handlers.connection(false);}; this.client.onStompError=(f)=>this.handlers.error({message:f.headers.message??'STOMP 오류',occurredAt:new Date().toISOString()}); this.client.activate();
  }
  private subscribe<T>(dest:string, fn:(v:T)=>void){ this.client!.subscribe(dest,(m:IMessage)=>{try{fn(JSON.parse(m.body) as T)}catch{}}); }
  sendMessage(roomId:number,clientMessageId:string,content:string,timeoutMs:number) {
    if(!this.client?.connected) return Promise.reject(new Error('STOMP_DISCONNECTED'));
    return new Promise<ChatMessage>((resolve,reject)=>{ const timer=setTimeout(()=>{this.pending.delete(clientMessageId);reject(new Error('MESSAGE_CONFIRM_TIMEOUT'));},timeoutMs); this.pending.set(clientMessageId,{resolve,reject,timer}); this.client!.publish({destination:`/app/chat/rooms/${roomId}/messages`,body:JSON.stringify({clientMessageId,content})}); });
  }
  async stop(){ for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('STOMP_STOPPED'));} this.pending.clear(); await this.client?.deactivate(); }
  get connected(){return this.client?.connected??false;}
}

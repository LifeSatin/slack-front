import type { WebClient } from '@slack/web-api';
import type { BackendClient } from '../clients/backend.js';
import type { StompClient } from '../clients/stomp.js';
import type { Store, ActiveNegotiation } from '../store.js';
import type { AgentEvent, NegotiationEvent, Phase } from '../types/contracts.js';
import { agentText, progressText, resultBlocks } from '../views/blocks.js';
import { stableUuid, truncate } from '../utils.js';

export class NegotiationService {
  private stompByUser=new Map<number,StompClient>();
  constructor(private store:Store,private backend:BackendClient,private slack:WebClient,private makeStomp:(userId:number,handlers:any)=>StompClient,private confirmTimeout:number) {}
  ensureStomp(userId:number){ let s=this.stompByUser.get(userId); if(!s){s=this.makeStomp(userId,{message:()=>{},negotiation:(e:NegotiationEvent)=>void this.onNegotiation(e),agent:(e:AgentEvent)=>void this.onAgent(e),error:()=>{},connection:()=>{}});this.stompByUser.set(userId,s);s.start();} return s; }
  async schedule(input:{teamId:string;channelId:string;userId:string;text:string;requestKey:string;participants:string[]}){
    const user=this.store.getUser(input.teamId,input.userId); if(!user) throw new Error('USER_NOT_LINKED'); const link=this.store.getChannel(input.teamId,input.channelId); if(!link) throw new Error('CHANNEL_NOT_LINKED');
    const current=this.store.getActiveByRoom(link.internalRoomId); if(current) throw Object.assign(new Error('ALREADY_ACTIVE'),{current});
    if(!this.store.claim(input.requestKey,'schedule')) return;
    this.store.createNegotiation({teamId:input.teamId,channelId:input.channelId,roomId:link.internalRoomId,requesterSlackUserId:input.userId,participantSlackIds:JSON.stringify(input.participants),requestText:input.text,requestKey:input.requestKey});
    const posted=await this.slack.chat.postMessage({channel:input.channelId,text:progressText(input.text,input.participants,'dispatching')}); this.store.setParent(input.requestKey,posted.ts!);
    try { const stomp=this.ensureStomp(user.internalUserId); if(!stomp.connected) await this.waitConnected(stomp); await stomp.sendMessage(link.internalRoomId,stableUuid(input.requestKey),input.text,this.confirmTimeout); const response=await this.backend.startNegotiation(user.internalUserId,link.internalRoomId); if(response && 'sessionId' in response) this.store.bindSession(link.internalRoomId,response.sessionId,'analyzing'); }
    catch(e){ this.store.failRequest(input.requestKey); await this.slack.chat.update({channel:input.channelId,ts:posted.ts!,text:'❌ 요청을 전달하지 못했어요. 잠시 후 다시 시도해 주세요.'}); throw e; }
  }
  private waitConnected(s:StompClient){return new Promise<void>((resolve,reject)=>{const started=Date.now();const timer=setInterval(()=>{if(s.connected){clearInterval(timer);resolve();}else if(Date.now()-started>10000){clearInterval(timer);reject(new Error('STOMP_DISCONNECTED'));}},100);});}
  private async onNegotiation(e:NegotiationEvent){ let n=this.store.getBySession(e.sessionId); if(!n)n=this.store.bindSession(e.roomId,e.sessionId,e.type==='NEGOTIATION_PROGRESS'?e.phase:'result'); if(!n||!n.parentTs)return;
    if(e.type==='NEGOTIATION_PROGRESS'){if(['succeeded','failed'].includes(n.status))return;this.store.updatePhase(e.sessionId,e.phase);await this.slack.chat.update({channel:n.channelId,ts:n.parentTs,text:progressText(n.requestText,JSON.parse(n.participantSlackIds),e.phase)});return;}
    if(!this.store.deliverOnce(`${e.sessionId}:result:${e.status}`))return;this.store.finish(e.sessionId,e.status==='converged'?'succeeded':'failed',e.slot);await this.slack.chat.update({channel:n.channelId,ts:n.parentTs,text:e.status==='converged'?'일정이 확정됐어요.':'일정 조율에 실패했어요.',blocks:resultBlocks(e.status,e.slot,n.requestKey) as any});
  }
  private async onAgent(e:AgentEvent){const n=this.store.getBySession(e.sessionId);if(!n||!n.parentTs||['succeeded','failed'].includes(n.status)||!this.store.deliverOnce(`${e.sessionId}:agent:${e.id}`))return;await this.slack.chat.postMessage({channel:n.channelId,thread_ts:n.parentTs,text:truncate(agentText(e))});}
  async stop(){await Promise.all([...this.stompByUser.values()].map(s=>s.stop()));}
}

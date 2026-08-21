import type { ChatRoom, AgentEvent } from '../types/contracts.js';

export class BackendError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export class BackendClient {
  constructor(private baseUrl: string, private serviceToken?: string) {}
  private async request<T>(path: string, internalUserId: number, init: RequestInit = {}): Promise<T> {
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(new URL(path, this.baseUrl), { ...init, signal: controller.signal, headers: { 'Content-Type':'application/json','X-USER-ID':String(internalUserId),...(this.serviceToken?{'X-Internal-Token':this.serviceToken}:{}),...init.headers } });
      if (!res.ok) { let message='백엔드 요청에 실패했습니다.'; try { const e=await res.json() as any; if(typeof e.message==='string') message=e.message; } catch {} throw new BackendError(res.status,message); }
      if (res.status === 204 || res.headers.get('content-length') === '0') return undefined as T;
      return await res.json() as T;
    } finally { clearTimeout(timeout); }
  }
  createRoom(userId:number,title:string,memberIds:number[]) { return this.request<ChatRoom>('/chat/rooms',userId,{method:'POST',body:JSON.stringify({title,memberIds})}); }
  listRooms(userId:number) { return this.request<ChatRoom[]>('/chat/rooms',userId); }
  startNegotiation(userId:number,roomId:number) { return this.request<void|{sessionId:string}>(`/chat/rooms/${roomId}/negotiations`,userId,{method:'POST'}); }
  latestAgentEvent(userId:number,roomId:number) { return this.request<AgentEvent|undefined>(`/chat/rooms/${roomId}/agent-events/latest`,userId); }

  async createSlackOAuthLink(teamId:string,slackUserId:string) {
    return this.slackOAuthRequest<{connectUrl:string;expiresAt:string}>('/api/slack/oauth/links', {
      method:'POST',
      body:JSON.stringify({teamId,slackUserId})
    });
  }

  async getSlackOAuthLink(teamId:string,slackUserId:string) {
    return this.slackOAuthRequest<{connected:boolean;userId:number|null;name:string|null;linkedAt:string|null}>(
      `/api/slack/oauth/links/${encodeURIComponent(teamId)}/${encodeURIComponent(slackUserId)}`
    );
  }

  private async slackOAuthRequest<T>(path:string,init:RequestInit={}):Promise<T> {
    const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),10000);
    try {
      const res=await fetch(new URL(path,this.baseUrl),{...init,signal:controller.signal,headers:{'Content-Type':'application/json',...(this.serviceToken?{'X-Slack-Service-Token':this.serviceToken}:{}),...init.headers}});
      if(!res.ok){let message='Slack OAuth 백엔드 요청에 실패했습니다.';try{const e=await res.json() as any;if(typeof e.message==='string')message=e.message;}catch{}throw new BackendError(res.status,message);}
      return await res.json() as T;
    } finally {clearTimeout(timeout);}
  }
}

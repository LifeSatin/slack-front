import type { AgentEvent, Phase, Slot } from '../types/contracts.js';

const phaseText:Record<Phase,string>={analyzing:'요청을 분석하는 중',checking_calendars:'참가자 캘린더를 확인하는 중',negotiating:'가능한 시간을 조율하는 중',revalidating:'최종 시간을 다시 확인하는 중'};
export const progressText=(request:string,participants:string[],phase:Phase|'dispatching')=>`📅 *일정 조율을 시작했어요.*\n요청: ${request}\n참가자: ${participants.map(x=>`<@${x}>`).join(', ')}\n상태: ${phase==='dispatching'?'요청을 전달하는 중':phaseText[phase]}`;
export const agentText=(e:AgentEvent)=>`${{MESSAGE:'💭',PROPOSE:'🗓️',ACCEPT:'✅',REJECT:'↩️'}[e.eventType]} ${e.message}`;
export function resultBlocks(status:'converged'|'failed',slot:Slot|null,requestKey:string){
  if(status==='failed') return [{type:'section',text:{type:'mrkdwn',text:'❌ *일정 조율에 실패했어요.* 조건을 바꿔 다시 시도해 주세요.'}},{type:'actions',elements:[{type:'button',action_id:'meetu_retry',value:requestKey,text:{type:'plain_text',text:'다시 요청하기'}}]}];
  if(!slot) return [{type:'section',text:{type:'mrkdwn',text:'⚠️ 일정이 확정되었지만 시간 정보를 받지 못했어요.'}}];
  const f=new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',year:'numeric',month:'long',day:'numeric',weekday:'short',hour:'2-digit',minute:'2-digit',hour12:false});
  return [{type:'section',text:{type:'mrkdwn',text:`✅ *일정이 확정되고 Google Calendar에 등록됐어요.*\n${f.format(new Date(slot.start))}–${new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(slot.end))} (Asia/Seoul)`}}];
}
export const helpText='*Meet:U 사용법*\n`/meetu connect` Calendar 연결\n`/meetu init [방 이름]` 채널 초기화\n`/meetu status` 연결 상태\n`/meetu schedule <요청>` 일정 조율\n`/meetu retry` 마지막 요청 재시도';

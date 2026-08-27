# ulw — ultrawork for Claude Code

`ulw` 는 omo/Codex 의 **ultrawork** 디렉티브를 Claude Code 로 이식한 플러그인이다.
증거 없이는 "완료" 라고 말하지 않는 실행 모드를 강제한다: tier triage →
바인딩 goal → 영속 노트패드 → `TodoWrite` 상태 추적 →
PIN → RED → GREEN → SURFACE → CLEAN 루프 → 3층 stop rules.

## 구성

| 경로 | 내용 |
|---|---|
| `skills/ulw/SKILL.md` | 디렉티브 본체. `<ultrawork-mode>` … `</ultrawork-mode>` 마커 안이 계약 본문이고, 마커 바깥에 원본 대비 구조 diff 체크리스트와 대체 근거 주석이 있다 |
| `.claude-plugin/plugin.json` | `skills: ["./skills/ulw"]` + `mcpServers.ulw-goal`. `claude plugin validate` 가 "skills entries must be directories containing SKILL.md" 로 요구하는 형태 |
| `hooks-handlers/on-user-prompt-submit.mjs` | `ultrawork`/`ulw` 프롬프트에 디렉티브 **포인터**를 주입. 원본 codex-hook.ts 의 3중 가드 이식 |
| `hooks-handlers/on-stop.mjs` | 미완료 goal 이 있으면 `{"decision":"block"}` 으로 정지 차단. `stop_hook_active` 로 무한 루프 방지 |
| `bin/ulw-loop-core.mjs`, `bin/ulw-loop.mjs` | goal 상태머신 + evidence audit. `.omo/ulw-loop/` 호환 포맷 |
| `mcp/ulw-goal-server.mjs` | `create_goal` / `get_goal` / `complete_goal` 을 노출하는 stdio MCP 서버 (의존성 0, JSON-RPC 직접 구현) |
| `test/` | `cd ~/.claude/skills/ulw && node --test 'test/*.test.mjs'`. **주의**: node v22 에서 `node --test <디렉토리>` 형태는 디렉토리를 모듈로 해석해 죽는다 |
| `LICENSES/` | 상류 라이선스 전문 2본 (아래 라이선스 절 참조) |

## 사용 — 명시적 호출 전용

`/ulw:ulw` 로 직접 호출한다. 활성화되면 그 턴의 **첫 줄이 정확히**
`ULTRAWORK MODE ENABLED!` 여야 한다.

**자동 트리거는 꺼져 있다.** 원본 omo 훅은
`/(?:ultrawork|ulw(?!-(?:plan|research)))/i` 에 매치되는 모든 프롬프트에서
발화하는데, 그러면 이 플러그인을 *논의하는* 대화에서도 켜진다. 그래서 두 군데를
막았다:

1. `hooks/hooks.json` — `UserPromptSubmit` 을 `hooks` 밖 `_disabled` 로 파킹.
   핸들러와 테스트 57본은 그대로 살아있다.
2. `skills/ulw/SKILL.md` frontmatter — `description` 에서 트리거 문구를 빼고
   `EXPLICIT INVOCATION ONLY` 로 못박음. 안 그러면 Claude 가 설명만 보고
   스킬을 자율 호출한다.

되살리려면 `_disabled` 의 `UserPromptSubmit` 블록을 `hooks` 안으로 옮기고
description 의 트리거 문구를 되돌리면 된다. (배선을 검사하는 테스트 2본이
`test/integration.test.mjs` 에 있으니 같이 뒤집어야 한다.)

`Stop` 훅은 계속 켜둔다 — `goals.json` 이 없으면 아무것도 안 하므로,
ulw 를 안 쓰는 세션에서는 존재하지 않는 것과 같다.

## 원본과의 관계

- 원본: `oh-my-opencode` (omo) 저장소의
  `packages/prompts-core/prompts/ultrawork/codex.md` (483줄, dev 브랜치).
- 이 저장소의 `skills/ulw/SKILL.md` 는 그 파일의 **수정된 번역본**이다.
  Codex 전용 도구(`update_plan`, `multi_agent_v1.spawn_agent`, `wait_agent`,
  `send_input`, `create_goal`, `~/.codex/agents/*.toml` 의 `agent_type`)를
  Claude Code 대응물(`TodoWrite`, `Task`, `TaskOutput`, `SendMessage`,
  바인딩 `# Goal` 블록, `subagent_type`)로 바꿨고, `multi_agent_v2` 스키마
  분기는 단일 `Task` 호출 규약으로 접었다.
- 섹션 단위 대조표와 항목별 대체 근거는 `skills/ulw/SKILL.md` 하단에 있다.

## 라이선스 (LICENSING NOTICE)

원본 omo 저장소는 **Sustainable Use License 1.0 (SUL-1.0)** 이다
(저장소 루트 `LICENSE.md`). 이 플러그인은 그 저작물의 파생물이므로 SUL-1.0
조건을 그대로 승계한다.

**MODIFICATION NOTICE (SUL-1.0 "Notices" 조항이 요구하는 prominent notice):**
This software contains a MODIFIED copy of the ultrawork directive from the
`oh-my-opencode` (omo) project. The directive at `skills/ulw/SKILL.md` has
been modified: it was translated from the Codex tool surface to the Claude
Code tool surface (tool names, subagent routing, QA channels, and the goal
registration path were changed). It is NOT the original, unmodified work.

SUL-1.0 요약 (전문이 아님 — 구속력은 원본 `LICENSE.md` 전문에 있다):

- **로컬/개인 사용**: 내부 업무 목적, 비상업적 목적, 개인 사용은 자유롭다.
  지금 이 플러그인은 로컬 사용이므로 추가 제약이 없다.
- **재배포 조건** (공개하려면 셋 다 충족해야 한다):
  1. **무료 + 비상업 한정** — 유료 판매나 상업적 제공 불가.
  2. **수정 고지(prominent notice)** — 원본을 수정했다는 사실을 눈에 띄게
     밝혀야 한다. 위 MODIFICATION NOTICE 블록이 그 역할이다.
  3. **라이선스 사본 동봉** — 사본을 받는 누구나 SUL-1.0 전문을 함께
     받아야 한다. 이미 동봉했다: `LICENSES/SUL-1.0-oh-my-openagent.md`
     (omo 저장소 루트 `LICENSE.md` 전문 그대로).
- **고지 제거 금지** — licensor 의 라이선스·저작권 고지를 지우거나 가릴 수
  없다.
- **보증 없음** — as is, 책임 없음.

### 상류 라이선스는 하나가 아니다 — 파트별로 갈린다

| 이 플러그인의 파트 | 상류 원본 | 상류 라이선스 |
|---|---|---|
| `skills/ulw/SKILL.md` (번역본) | `packages/prompts-core/prompts/ultrawork/codex.md` | **SUL-1.0** — 컴포넌트 밖이라 저장소 루트 `LICENSE.md` 적용 |
| `hooks-handlers/on-user-prompt-submit.mjs` | `packages/omo-codex/plugin/components/ultrawork/src/{codex-hook,skill-pointer}.ts` | MIT (컴포넌트 자체 `LICENSE`) |
| `bin/*`, `mcp/*`, `hooks-handlers/on-stop.mjs` | `packages/omo-codex/plugin/components/ulw-loop/src/*` (포맷·필드명 참조) | MIT (컴포넌트 자체 `LICENSE`) |
| `skills/ulw/references/*` | 위 두 컴포넌트의 `skills/*/references/*` (바이트 동일 사본) | MIT |

전문 2본을 `LICENSES/` 에 동봉했다:
`SUL-1.0-oh-my-openagent.md`, `MIT-omo-plugin-components.txt`
(MIT — Copyright (c) 2026 Yeongyu Kim).

**혼합물 전체를 재배포할 때의 기준은 더 엄격한 SUL-1.0 이다** — 무료·비상업
한정 + 수정 고지 + 라이선스 사본 동봉. MIT 파트만 따로 떼어 쓰면 MIT 조건만
적용되지만, SKILL.md 와 함께 배포하는 한 SUL-1.0 이 전체를 덮는다.

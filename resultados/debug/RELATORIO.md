# Avaliação de duplicação e código morto

Projeto: **debug 4.4.3**

- Repositório: `/tmp/auditoria-debug-eval`
- Commit: 666dbc5
- Gerenciador de pacotes: npm
- Estado da avaliação: aborted
- Motivo: O script de testes falhou antes das refatorações. O script de lint falhou antes das refatorações. Nada foi alterado.

## Métricas

| | Antes | Depois |
| --- | ---: | ---: |
| Linhas de código | 552 | — |
| Índice de manutenibilidade | 34.6 | — |
| Linhas duplicadas | 35 | — |
| Classes de clones | 2 | — |
| Estruturas repetitivas (não contadas) | 2 | — |
| Densidade de duplicação | 0.0634 | — |
| Símbolos mortos | 0 | — |
| Instruções inalcançáveis | 0 | — |
| Dívida estimada (min) | 70 | — |
| Cobertura de linhas (%) | não medida | não medida |
| Tempo médio do lint (ms) | 1356 ± 20 | não configurado |

## Verificações

- Testes antes: `npm run test` — código 1.
- Testes depois: `não executado` — código não executado.
- Erro de execução dos testes: nenhum.
- Lint antes: `npm run lint` — falhou.
- Lint depois: `não executado` — não executado.
- Erro de execução do lint: nenhum.
- Alterações aplicadas: 0.
- Alterações revertidas após falha: não.


A avaliação executa os scripts `test` e, quando definido, `lint` no `package.json`. A cobertura é medida automaticamente apenas quando o Vitest e um provedor V8/Istanbul compatível estão instalados; em outros casos, aparece como “não medida”. Os arquivos de log dos testes e do lint ficam junto aos relatórios.

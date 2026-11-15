# Comparação com ferramentas existentes

Mesmo sistema, mesma versão: axios 1.21.0 (tag `v1.21.0`), sem alteração. Só `lib/` e `index.js`. As ferramentas foram executadas nas versões mais recentes disponíveis no npm na data do trabalho.

| Ferramenta | Versão | Para quê | Resultado bruto |
| --- | --- | --- | --- |
| jscpd | 5.4.3 | clones | `comparacao/jscpd.json` |
| Knip | 6.45.1 | código morto | `comparacao/knip.json` |
| unimported | 1.31.1 | arquivos sem uso | `comparacao/unimported.txt` |
| ESLint + eslint-plugin-sonarjs (regras do SonarJS) | 10.15.0 + 4.2.2 | variáveis mortas, funções idênticas | `comparacao/eslint-sonarjs.json` |
| oxlint | 1.93.0 | variáveis mortas | `comparacao/oxlint.json` |
| Esta ferramenta | — | tudo | `relatorio.json` |

**Não executados:** o PMD CPD, que é a referência clássica de clones, porque o ambiente bloqueou a execução do binário baixado do GitHub; e o SonarQube completo, que exige servidor próprio. O que existe do Sonar aqui são só as regras do SonarJS, que funcionam arquivo por arquivo. O enunciado aceita "ou similares".

Uma versão anterior desta comparação usou versões antigas (jscpd 4.0.5, Knip 5.43). O jscpd 4 descartava em silêncio os arquivos com mais de 100 KB ou 1000 linhas, o que excluía `http.js` e `utils.js` do axios, e por isso parecia perder um clone óbvio. Na 5.4.3 os resultados com e sem os limites são idênticos.

## Duplicação

| | jscpd | Esta ferramenta | ESLint + SonarJS | oxlint | PMD, SonarQube |
| --- | ---: | ---: | ---: | ---: | --- |
| Clones reportados | 7 | 19 classes (mais 11 estruturas repetitivas, à parte) | 0 | não tem regra | não executados |
| Tipos detetados | só exatos (tipo 1) | tipos 1, 2 e 3 | só funções idênticas dentro de um arquivo | — | — |
| Linhas duplicadas | 90 (0,94 %) | 343 (5,18 %) | — | — | — |

O `no-identical-functions` do SonarJS achou 0, embora `decodeURIComponentSafe` seja idêntica em `fetch.js` e `http.js`: a regra só compara funções dentro do mesmo arquivo. O SonarJS também reportou 2 literais repetidos, que não são clones. Os 7 clones do jscpd estavam todos entre os nossos antes do filtro de variedade.

### Precisão (revisão manual dos achados)
Li os dois trechos de cada achado e classifiquei como **real**, **parcial** (idioma comum de código, semelhante mas não extraível de forma útil) ou **falso positivo**. Os rótulos da nossa ferramenta estão em `comparacao/rotulos-clones.json`, para qualquer outra pessoa refazer ou discordar.

| | Achados | Reais | Parciais | Falsos positivos | Precisão (só reais) | Precisão (reais + parciais) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| jscpd 5.4.3 | 7 | 6 | 0 | 1 | 86 % | 86 % |
| Esta ferramenta, sem filtro | 26 | 13 | 5 | 8 | 50 % | 69 % |
| Esta ferramenta, com filtro de variedade | 19 | 13 | 5 | 1 | 68 % | 95 % |

**Filtro de variedade.** Os falsos positivos eram listas de nomes e tabelas de constantes. O filtro calcula a entropia de Shannon dos tokens normalizados do trecho e marca como estrutura repetitiva, fora da contagem, o que ficar abaixo de 2,9 bits. Removeu 7 dos 8 falsos positivos e nenhum clone real. Sobrou 1 falso positivo: `isIPv6Unspecified` e `isIPv6Loopback` em `shouldBypassProxy.js`, que se parecem na forma mas fazem coisas diferentes.

Ressalvas importantes:
- **O limiar foi calibrado nos mesmos 26 achados em que a precisão é medida.** A melhora de 50 % para 68 % (95 % com parciais) é, portanto, otimista. O valor 3,0 foi testado primeiro e perdia 2 clones reais; 2,9 é o maior valor redondo que mantém todos. A margem é estreita: o clone real de menor entropia tem 2,94.
- O avaliador é uma só pessoa e o julgamento é subjetivo. O arquivo de rótulos permite que uma segunda pessoa classifique os mesmos achados e que se calcule a concordância entre as duas.
- O gabarito injetado, abaixo, mede o custo do filtro sobre clones que ele não viu.
- A precisão do jscpd, com apenas 7 achados, tem pouca margem estatística.

### Revocação (gabarito por injeção de clones)
Sem gabarito só se mede precisão. O script `auditoria/bench/gabarito.js` copia `lib/` do axios, injeta 40 clones conhecidos de funções reais e mede quantos cada ferramenta acha. Um clone conta como achado se cobre pelo menos metade da função, nos dois lados. Três sementes diferentes sorteiam funções diferentes (3 × 40 = 120 injeções, em `comparacao/gabarito-semente*.json`).

| Clone injetado | Qtd. | Esta ferramenta (com filtro) | Esta ferramenta (sem filtro) | jscpd 5.4.3 |
| --- | ---: | ---: | ---: | ---: |
| Tipo 1: cópia exata | 30 | 30 | 30 | 30 |
| Tipo 2: nomes locais e literais trocados | 45 | 45 | 45 | 0 |
| Tipo 3: 10 % das instruções alteradas | 15 | 14 | 15 | 15 |
| Tipo 3: 20 % das instruções alteradas | 15 | 14 | 15 | 15 |
| Tipo 3: 30 % das instruções alteradas | 15 | 11 | 11 | 11 |
| **Total** | **120** | **114 (95 %)** | **116 (97 %)** | **71 (59 %)** |

- O jscpd compara tokens exatos, então não vê o tipo 2 por construção (0 de 45). Essa é a vantagem concreta da normalização de tokens.
- Nas edições do tipo 3 o jscpd acompanha a nossa ferramenta, porque sobra um trecho idêntico grande o bastante.
- O filtro de variedade custou 2 das 116 detecções (1,7 %), ambas do tipo 3.
- Em 22 das 45 funções injetadas com edições, o detector de tipo 3 (similaridade de Jaccard) é o que dispara. Portanto o detector funciona, e o zero de clones tipo 3 no axios significa que o projeto não tem quase-clones entre funções, não que o detector esteja quebrado.
- Com 30 % de alteração, a revocação cai para 11 de 15 nas duas ferramentas.

Limitações do gabarito: as edições são sintéticas (remover ou acrescentar instruções e renomear), só há cópias de funções de topo em arquivo separado, e a ferramenta e o gabarito foram escritos pela mesma pessoa, então o gabarito pode estar inconscientemente ajustado ao detector. A primeira versão do critério de acerto estava frouxa (contava fragmentos curtos como função inteira) e foi corrigida antes de qualquer número ser publicado.

## Código morto

O que é "morto" depende de qual parte do código é API pública. O `package.json` do axios declara `"./unsafe/*": "./lib/*"`, e pela regra do Node o `*` cruza barras: **todo arquivo de `lib/` é importável de fora** como `axios/unsafe/...`. Pelo grafo de imports do próprio projeto, alguns arquivos não têm nenhum uso; pela API declarada, nenhum é inalcançável.

| Ferramenta | O que reporta em `lib/` | Observação |
| --- | --- | --- |
| Esta ferramenta, padrão estrito | 0 | trata todo `lib/` como API pública |
| Esta ferramenta, com `--internal-export './unsafe/*'` | 4: `deprecatedMethod.js` (arquivo e export), `env/classes/FormData.js` e o export default de `fetch.js` | só vale se se aceitar `./unsafe/*` como interno |
| Knip 6.45.1 | 0 | também trata `lib/` como API pública |
| unimported 1.31.1 | 8 arquivos: 2 sem uso e 6 falsos positivos | os 6: `index.d.ts`, `helpers/null.js` e `platform/browser/*`, que são usados pelo campo `browser` do `package.json` |
| ESLint 10 e oxlint | 22 parâmetros de `catch` não usados | nenhuma variável, arquivo ou export morto de verdade |

Leitura honesta: os 4 achados da nossa ferramenta são código sem uso **no projeto e nos testes** e foram confirmados à mão (nenhuma referência), mas são alcançáveis por `axios/unsafe/...`. Chamá-los de "mortos" é uma decisão sobre o que é API, que a ferramenta agora exige que o utilizador declare. O nome `unsafe` sugere que é interno, mas remover esse código pode quebrar quem importa esses caminhos. Com o Knip 5.43 (versão anterior, não reexecutada) o resultado era outro, 11 achados; a diferença provavelmente vem de o Knip 6 passar a tratar `./unsafe/*` como API pública.

Esta comparação também expôs um defeito da nossa ferramenta, já corrigido: os padrões com curinga (`*`) do campo `exports` nunca funcionaram, por um erro de escape na expressão regular. Antes da correção, a ferramenta tratava como não públicos arquivos que o Node expõe.

Para código morto não foi feito gabarito injetado: só há poucos achados, então não dá para falar em revocação.

## Limitações desta comparação
- Um único sistema alvo (axios), e a revisão manual tem um único avaliador.
- O limiar do filtro de variedade foi calibrado na mesma amostra que mede a precisão.
- O gabarito injetado é sintético.
- Para código morto, o resultado depende de uma decisão sobre a API pública.
- O PMD CPD e o SonarQube completo não foram executados.

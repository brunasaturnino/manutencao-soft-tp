# Auditoria de duplicação e código morto

Sistema analisado: axios 1.21.0, clonado de `axios/axios` na tag v1.21.0. Não é um exemplo inventado: é a biblioteca HTTP que o scanner lê, limpa e mede.

## Resposta ao feedback

O nome “doutrina de código” não corresponde a um conceito da literatura. O fenômeno medido aqui é code smell (Fowler e Beck): duplicação estrutural e código morto. A ferramenta segue o desenho de detetores já usados em manutenção — PMD CPD, SourcererCC e Deckard para clones; Knip, `no-unused-vars` e a análise de exports do TypeScript para código morto.

Técnicas:

- Duplicação, tipos 1 a 3 de Roy e Cordy. Tipos 1 e 2: tokens normalizados (identificador e literal viram símbolos), janela deslizante com hash de Rabin–Karp, e confirmação pela subárvore da função com os nomes locais renomeados. Tipo 3: similaridade de Jaccard entre os conjuntos de janelas de duas funções. Clone semântico de tipo 4 fica de fora.
- Código morto: grafo de imports a partir dos entry points do `package.json` e dos testes. Binding privado sem leitura é morto. Export que ninguém importa também, desde que o ficheiro não seja API pública. Código depois de `return`/`throw` no mesmo bloco é inalcançável. Import dinâmico marca o módulo inteiro como usado. Ficheiro não alcançável é só reportado.
- Os pares de janelas sobrepostas fundem-se em classes de clones. Uma classe cujos dois lados se tocam no mesmo ficheiro é repetição em sequência (tabela de configuração, série de atribuições). Uma classe cujos tokens normalizados têm entropia de Shannon abaixo de 2,9 bits é lista ou tabela de baixa variedade. Ambas ficam registadas à parte e não contam como duplicação a extrair. O limiar 2,9 foi calibrado sobre os clones do próprio axios classificados à mão (veja `COMPARACAO.md`); é uma limitação.
- Refatoração segura: delegar função de topo com corpo idêntico; consolidar função privada idêntica (ou só com nomes locais diferentes) de ficheiros distintos num módulo partilhado, importado pelos originais; extrair bloco idêntico sem `return`/`this` para uma função local; apagar símbolo morto, preservando inicialização com efeito. Se a suíte ou o ESLint falham, o diff é revertido, incluindo os módulos criados.

## Métricas

O índice de manutenibilidade é o de Oman e Hagemeister, na escala 0–100 usada pelo Visual Studio (volume de Halstead, complexidade ciclomática e linhas). A dívida em minutos é estimativa de remediação: 10 min por símbolo morto, 5 min por instrução inalcançável e 2 min por linha em clone de tipo 1 ou 2. O enunciado fala em diminuição da manutenibilidade; a limpeza faz a dívida descer e o índice subir.

| | Antes | Depois |
| --- | ---: | ---: |
| Linhas de código | 6623 | 6583 |
| Índice de manutenibilidade | 44.5 | 45.5 |
| Linhas duplicadas | 343 | 252 |
| Classes de clones | 19 | 15 |
| Estruturas repetitivas (não contadas) | 11 | 11 |
| Densidade de duplicação | 0.0518 | 0.0383 |
| Símbolos mortos | 2 | 0 |
| Instruções inalcançáveis | 0 | 0 |
| Dívida estimada (min) | 706 | 504 |
| Cobertura de linhas dos testes unitários (%) | 91.84 | 91.83 |
| Tempo médio do ESLint (ms, média ± desvio padrão de 10 execuções) | 918 ± 47 | 863 ± 66 |

Superfície pública: o padrão de exports `./unsafe/*` foi declarado interno (`--internal-export`). É uma decisão, não um fato: sem ela, tudo em `lib/` é API pública pelo `package.json` do axios e a ferramenta não encontra código morto nem remove nada.

Alterações aplicadas: 6. Revertidas porque a suíte ou o ESLint falhou: não.

A cobertura é a do projeto `unit` do Vitest, não a dos testes de browser. O relatório é gerado mesmo quando a suíte já falha. Testes falhados antes: 4. Depois: 4. As falhas que já existiam antes da limpeza não são deste trabalho (neste ambiente, testes que dependem de rede). A percentagem pode subir porque linhas mortas saíram do denominador, não porque a suíte tenha ganhado testes novos.

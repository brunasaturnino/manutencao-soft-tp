# Auditoria de duplicação e código morto

Trabalho de Manutenção de Software. Uma ferramenta em Node.js que audita um projeto JavaScript, encontra **código duplicado** e **código morto**, aplica refatorações seguras e mede o efeito (manutenibilidade, cobertura de testes e tempo do ESLint). O sistema analisado é o **axios 1.21.0**.

- `auditoria/`: a ferramenta (código em `src/`, testes em `test/`, exemplo em `fixtures/mini/`).
- `resultados/`: o que ela produziu no axios. Comece por `RELATORIO.md` (métricas antes e depois) e `COMPARACAO.md` (comparação com jscpd e Knip).

## Requisitos
- Node.js (testado com a versão 22) e git.
- Para o comando `evaluate`, o projeto alvo precisa ser um repositório git com as dependências instaladas e o provedor de cobertura do Vitest:

```bash
git clone --depth 1 --branch v1.21.0 https://github.com/axios/axios alvos/axios
cd alvos/axios
npm ci --ignore-scripts
npm i --no-save --ignore-scripts @vitest/coverage-v8@$(node -p "require('./node_modules/vitest/package.json').version")
```

## Instalação e testes da ferramenta
```bash
cd auditoria
npm install
npm test
```

## Uso
Os três comandos recebem `--repo` (projeto alvo) e `--out` (pasta de saída). O padrão de `--repo` é `../alvos/axios`, relativo à raiz deste repositório.

```bash
# 1. Só analisa e gera relatorio.txt e relatorio.json (não altera o projeto)
node src/cli.js scan --repo ../alvos/axios --out ../resultados

# 2. Analisa e aplica as refatorações no projeto (altera os arquivos!)
node src/cli.js apply --repo ../alvos/axios --out ../resultados

# 3. Mede, aplica, mede de novo, reverte se algo quebrar e gera o relatório completo
node src/cli.js evaluate --repo ../alvos/axios --out ../resultados --internal-export './unsafe/*'
```

Opções: `--min-tokens` (padrão 30) e `--min-lines` (padrão 6) ajustam o tamanho mínimo de um clone. `--min-entropy` (padrão 2,9) é o limiar do filtro de variedade: clones cujos tokens normalizados têm entropia de Shannon abaixo dele são tratados como lista ou tabela e não contam como duplicação.

`--internal-export` (repetível) declara que um padrão do campo `exports` do `package.json` é interno. Por padrão a ferramenta respeita o `package.json`: o axios declara `"./unsafe/*": "./lib/*"`, então **todo `lib/` é API pública e ela não encontra código morto nem remove nada**. Os resultados em `resultados/` foram gerados com `--internal-export './unsafe/*'`, uma decisão que pode quebrar quem importa `axios/unsafe/...`. Veja `resultados/COMPARACAO.md`.

Um quarto comando, `relatorio`, regenera só o `RELATORIO.md` a partir do `avaliacao.json` já gravado:

```bash
node src/cli.js relatorio --out ../resultados
```

Atenção: `apply` e `evaluate` **modificam** o projeto alvo. Trabalhe numa cópia. O `evaluate` demora vários minutos (suíte de testes com cobertura duas vezes e 10 execuções do ESLint por lado) e aborta sem alterar nada se a suíte não conseguir rodar antes da limpeza.

Gabarito de revocação (injeta 40 clones conhecidos numa cópia de `lib/` e mede quantos a ferramenta acha; `--jscpd` compara com o jscpd, que precisa de rede para o `npx`):

```bash
node bench/gabarito.js --repo ../alvos/axios --work /tmp/gabarito --out /tmp/gabarito.json --seed 1 --jscpd
```

A pasta de `--work` não pode existir. Os resultados de 3 sementes estão em `resultados/comparacao/`.

Demonstração rápida, sem precisar do axios:

```bash
node src/cli.js scan --repo fixtures/mini --out /tmp/mini --min-tokens 20 --min-lines 4
```

## O que a ferramenta faz
| Módulo | Função |
| --- | --- |
| `files.js`, `parse.js` | Descobre os arquivos, lê a API pública do `package.json` e gera a árvore sintática (Babel) e os tokens normalizados |
| `clones.js` | Clones tipos 1 e 2 (janela deslizante com hash Rabin–Karp sobre tokens normalizados), tipo 3 (similaridade de Jaccard entre funções), fusão de janelas sobrepostas em classes e detecção de repetições em sequência |
| `dead.js` | Código morto: grafo de imports, exports sem uso, variáveis privadas não lidas, código após `return`/`throw`, arquivos inalcançáveis |
| `metrics.js` | Linhas, complexidade ciclomática, volume de Halstead, índice de manutenibilidade (Oman–Hagemeister, 0 a 100), duplicação e dívida estimada |
| `apply.js` | Refatorações: delegar função idêntica, **consolidar função idêntica entre arquivos num módulo partilhado**, extrair bloco repetido, remover código morto |
| `evaluate.js` | Orquestra a medição antes e depois, a suíte, o ESLint e a reversão |
| `audit.js`, `cli.js` | Relatório e linha de comando |

A dívida estimada é uma conta própria e declarada: 10 min por símbolo morto, 5 min por instrução inalcançável e 2 min por linha em clone de tipo 1 ou 2.

## Resultado no axios 1.21.0
Detalhes em `resultados/RELATORIO.md`. Em resumo, a limpeza reduz as linhas duplicadas de 343 para 252, elimina os 2 símbolos mortos e sobe o índice de manutenibilidade de 44,5 para 45,5, sem alterar o número de testes que falham (4 antes e 4 depois, todos de rede neste ambiente), com cobertura praticamente igual (91,84 % e 91,83 %) e o tempo do ESLint sem efeito (918 ± 47 ms antes e 863 ± 66 ms depois nesta rodada; em três rodadas independentes a diferença foi de +13, −17 e −55 ms, ou seja, muda de sentido).

Comparação com o jscpd e o Knip em `resultados/COMPARACAO.md`: nos clones injetados, a ferramenta acha 95 % (o jscpd, 58 %, e 0 % dos de tipo 2); no código morto, o resultado depende de declarar `./unsafe/*` como interno: com isso a ferramenta acha 4 itens sem uso no projeto (confirmados à mão); sem isso, 0, igual ao Knip 6.

## Limitações
- Código morto só existe sob a decisão de tratar `./unsafe/*` como interno. Um defeito de escape fazia os curingas de `exports` nunca funcionarem; foi corrigido e testado.
- Só JavaScript (`.js`, `.mjs`, `.cjs`). Clones semânticos (tipo 4) ficam de fora.
- Não há clones de tipo 3 no axios. O detector funciona (dispara em 22 de 45 quase-clones injetados), então o zero reflete o projeto, não um defeito.
- A precisão medida à mão é de 68 % (reais) a 95 % (reais e parciais), mas o limiar do filtro de variedade foi calibrado na mesma amostra, então o valor é otimista, e há um só avaliador. Veja `resultados/COMPARACAO.md`.
- O gabarito injetado é sintético e foi escrito pela mesma pessoa que escreveu o detector.
- A reversão do `evaluate` é tudo ou nada.
- O SonarQube não foi executado.

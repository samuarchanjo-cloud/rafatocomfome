# Configuração do Supabase

## Estado encontrado antes da alteração

Em 20/07/2026, o projeto remoto possuía apenas `public.products`, com 37 registros. A coluna `category` usa IDs textuais (`combos`, `hamburgueres`, `pasteis`, `porcoes` e `bebidas`). A migração não cria, renomeia ou recria `products`, não liga `category` por chave estrangeira e não executa `INSERT`, `UPDATE` ou `DELETE` nessa tabela.

## Aplicar a migração

1. Execute o bloco **ANTES** de `verification.sql` e salve os resultados.
2. Em **Table Editor > products**, exporte um CSV de segurança.
3. Abra **SQL Editor** no projeto correto.
4. Execute todo o arquivo `migrations/20260720_admin_delivery_security.sql`.
5. Execute o bloco **DEPOIS** de `verification.sql` e compare contagem e checksum.
6. Abra o cardápio em janela anônima e confirme a leitura pública.

A migração adiciona a `products` somente `featured` e `sort_order`, usando `ADD COLUMN IF NOT EXISTS`. Não substitui triggers preexistentes, não normaliza status nem modifica qualquer campo legado. Uma guarda transacional compara contagem e checksum dos oito campos existentes antes do `COMMIT`; qualquer diferença aborta e reverte toda a migração.

`categories` é criada separadamente para o painel administrativo, mas não possui FK com `products.category`. Seus registros iniciais são inseridos apenas para valores que já existam em `products`.

As políticas SELECT existentes de `products` são preservadas e uma política pública adicional garante leitura dos registros com `visible = true`. Políticas antigas de escrita são substituídas por políticas baseadas em Supabase Auth e `app_admins`.

## Criar o administrador

1. Em **Authentication > Users**, crie uma usuária com e-mail e senha.
2. Copie o UUID dessa usuária.
3. Execute no SQL Editor:

```sql
insert into public.app_admins (user_id)
values ('UUID-DO-USUARIO-ADMIN');
```

4. Depois de criar a conta necessária, desative cadastros públicos em **Authentication > Sign In / Providers > Email**, se não pretende permitir novas contas.

O frontend usa apenas Supabase Auth. A senha antiga no JavaScript foi removida. Nunca adicione `service_role` ao Vite ou ao navegador.

## Variáveis de ambiente

```dotenv
VITE_SUPABASE_URL=https://SEU-PROJETO.supabase.co
VITE_SUPABASE_ANON_KEY=SUA_CHAVE_PUBLICA_ANON
```

Somente a chave pública `anon` deve ser usada. As duas variáveis já existem no `.env.local` deste workspace; confira as mesmas variáveis no provedor de hospedagem antes de um deploy manual.

## Taxas ainda pendentes

A migração não inventa valores. Por segurança, ela inicia com:

- regra abaixo de 1 km: `bloqueado`;
- distância máxima: não definida;
- nenhuma faixa de taxa cadastrada.

Enquanto isso, entregas ficam bloqueadas, mas retirada no local continua disponível durante o horário de funcionamento. No painel, informe:

1. se abaixo de 1 km é grátis, taxa fixa ou bloqueado;
2. o valor, se escolher taxa fixa;
3. a distância máxima de atendimento;
4. faixas contínuas, por exemplo 1,00–1,99 km e 2,00–2,99 km, com os valores reais.

O banco impede taxas negativas e sobreposição de faixas. O painel também impede lacunas entre faixas ativas.

## Distância

O navegador solicita as coordenadas do dispositivo; o cliente não digita a distância. A prévia usa Haversine e a função `place_order` recalcula a distância no banco com as coordenadas recebidas, antes de calcular a taxa e salvar. Hoje essa é uma distância geográfica em linha reta. Para distância viária e validação entre endereço e coordenadas, integre futuramente um provedor de geocodificação/rotas; não há chave de mapas inventada nesta entrega.

## Teste manual recomendado

1. Entre no painel com a conta incluída em `app_admins`.
2. Cadastre a distância máxima, a regra abaixo de 1 km e pelo menos uma faixa real.
3. Edite um produto e atualize a página para confirmar persistência.
4. Envie uma foto JPG/PNG/WEBP de até 5 MB e confira o bucket.
5. Teste uma localização dentro de uma faixa e outra fora da distância máxima.
6. Teste pedido entre quarta e domingo, das 19:00 às 22:59, no fuso `America/Sao_Paulo`.
7. Teste fora desse período e confirme que não surge linha nova em `orders` e que o WhatsApp não abre.

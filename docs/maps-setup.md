# Configuração de localização e mapa

O checkout funciona sem chave externa usando ViaCEP para o endereço textual, Nominatim/AwesomeAPI para coordenadas e tiles do OpenStreetMap no seletor de PIN.

Para habilitar o Google Maps como primeira tentativa de geocodificação, configure no ambiente do Vite/Vercel:

```text
VITE_GOOGLE_MAPS_API_KEY=sua_chave_restrita
```

No Google Cloud, habilite **Maps JavaScript API** para a chave. Restrinja a chave aos domínios autorizados (Production e Preview) e somente às APIs necessárias. A chave não deve ser gravada no repositório.

O SDK do Google não é carregado na home: ele só é solicitado quando o cliente valida um endereço. Sem a variável, o fluxo existente permanece ativo automaticamente.

O mapa de confirmação também é carregado sob demanda. O cliente move o mapa sob um PIN central; a coordenada só ganha `location_source = map_pin` depois de tocar em **Confirmar este local**. O frontend recusa deslocamentos grosseiros maiores que 10 km em relação à região encontrada para o endereço, enquanto o `place_order_v2` recalcula distância, taxa e limite no servidor.

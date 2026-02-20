const express = require('express');
require('dotenv').config();

const { router } = require('./src/routes/buscaRoutes');

const app = express();
app.use(express.json());
app.use(router);

const PORT = process.env.PORT || 5232;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});

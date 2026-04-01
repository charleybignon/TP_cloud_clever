# Todo SSE — TP Clever Cloud

## Installation locale

```bash
npm install
cp .env.example .env
# Éditez .env avec les infos PostgreSQL locales, lancer un container Postgres pour tester si besoin
npm start
```

## Tests des endpoints

### Health
```bash
curl http://localhost:3000/health
```

### Créer une tâche
```bash
curl -X POST http://localhost:3000/todos \
  -H "Content-Type: application/json" \
  -d '{"title": "Préparer le rapport", "description": "Envoyer au prof une fois terminé", "due_date": "2024-12-01"}'
```

### Lister toutes les tâches
```bash
curl http://localhost:3000/todos
```

### Filtrer par statut
```bash
curl "http://localhost:3000/todos?status=pending"
```

### Mettre à jour une tâche
```bash
curl -X PATCH http://localhost:3000/todos/1 \
  -H "Content-Type: application/json" \
  -d '{"status": "done"}'
```

### Supprimer une tâche
```bash
curl -X DELETE http://localhost:3000/todos/1
```

### Tâches en retard
```bash
curl http://localhost:3000/todos/overdue
```

### Tester le SSE
```bash
# Terminal 1 — s'abonner
curl -N http://localhost:3000/alerts

# Terminal 2 — notifier
curl -X POST http://localhost:3000/todos/1/notify
```

## Déploiement Clever Cloud

```bash
clever create --org <orga_...> --type node --name todo-<votre-nom>
clever addon create postgresql-addon pg-todo-<votre-nom> --plan dev --org <orga_...>
clever service link-addon pg-todo-<votre-nom>
clever env set APP_NAME <votre-nom>
clever deploy
```
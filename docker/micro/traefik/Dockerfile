# Utiliser l'image officielle de Traefik 1.7 provenant de Docker Hub
FROM traefik:1.7

# Copier le fichier de configuration Traefik personnalisé
COPY ./traefik.toml /traefik.toml

# Définir les commandes par défaut pour le service Traefik
CMD ["--api", "--docker", "--docker.watch"]

# Vous pouvez ajouter d'autres commandes spécifiques au service Traefik si nécessaire
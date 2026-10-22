docker stop 9router
docker rm 9router
docker build -t 9router .
docker run -d --name 9router -p 20127:20127 --env-file .env -v 9router-data:/app/data 9router
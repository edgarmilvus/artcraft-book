docker build -t banner-service:dev .
docker run --rm -p 8787:8787 \
  --memory=512m --cpus=1.0 \
  --read-only --tmpfs /tmp:size=256m,noexec,nosuid \
  banner-service:dev

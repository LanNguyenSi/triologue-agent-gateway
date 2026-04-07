.PHONY: install dev build test typecheck docker-build docker-up docker-down clean

install:
	npm install

dev:
	npm run dev

build:
	npm run build

test:
	npm test

docker-build:
	docker build -t triologue-agent-gateway .

clean:
	rm -rf node_modules dist .next

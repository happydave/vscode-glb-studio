IMAGE = glb-studio-dev
DOCKER = docker run --rm -v "$$(pwd)":/workspace -w /workspace $(IMAGE)

.PHONY: image install compile bundle package watch test clean

image:
	docker build -t $(IMAGE) -f Dockerfile.dev .

install: image
	$(DOCKER) npm install

compile: image
	$(DOCKER) npm run compile

bundle: image
	$(DOCKER) npm run bundle

package: image
	$(DOCKER) npm run package

watch: image
	docker run --rm -it -v "$$(pwd)":/workspace -w /workspace $(IMAGE) npm run watch

test: image
	$(DOCKER) npm test

clean:
	rm -rf node_modules dist *.vsix

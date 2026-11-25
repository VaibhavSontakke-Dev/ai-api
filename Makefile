.PHONY: install run test check evals
install:
	npm ci
run: install
	npm start
test: install
	npm test
check: install
	npm run check
evals: install
	npm run evals

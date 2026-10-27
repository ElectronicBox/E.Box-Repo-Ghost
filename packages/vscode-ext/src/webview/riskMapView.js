(function () {
  const entries = Array.isArray(window.__REPO_GHOST_DATA__) ? window.__REPO_GHOST_DATA__ : [];
  const rows = document.getElementById("risk-rows");
  const filter = document.getElementById("filter");
  const empty = document.getElementById("empty");
  let sortKey = "riskScore";
  let descending = true;

  function riskColor(score) {
    const hue = Math.max(0, Math.min(120, 120 - Number(score) * 1.2));
    return `hsl(${hue} 72% 62%)`;
  }

  function render() {
    const query = filter.value.trim().toLowerCase();
    const visible = entries
      .filter((entry) => entry.filePath.toLowerCase().includes(query))
      .slice()
      .sort((left, right) => {
        const a = left[sortKey];
        const b = right[sortKey];
        const result =
          typeof a === "string" ? a.localeCompare(b) : Number(a) - Number(b);
        return descending ? -result : result;
      });

    const fragment = document.createDocumentFragment();
    visible.forEach((entry) => {
      const row = document.createElement("tr");
      const risk = document.createElement("span");
      risk.className = "risk";
      risk.style.backgroundColor = riskColor(entry.riskScore);
      risk.textContent = `${entry.riskScore.toFixed(1)}`;
      const values = [
        entry.filePath,
        risk,
        entry.commitCount,
        entry.distinctAuthors,
        entry.revertCount,
        entry.churn,
      ];
      values.forEach((value) => {
        const cell = document.createElement("td");
        if (value instanceof Node) cell.appendChild(value);
        else cell.textContent = String(value);
        row.appendChild(cell);
      });
      fragment.appendChild(row);
    });
    rows.replaceChildren(fragment);
    empty.hidden = visible.length !== 0;
  }

  document.querySelector("thead").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-sort]");
    if (!button) return;
    const nextKey = button.dataset.sort;
    if (sortKey === nextKey) descending = !descending;
    else {
      sortKey = nextKey;
      descending = nextKey !== "filePath";
    }
    render();
  });
  filter.addEventListener("input", render);
  render();
})();

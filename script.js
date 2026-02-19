function calc(){

  let o1 = parseFloat(document.getElementById("odd1").value);
  let oX = parseFloat(document.getElementById("oddX").value);
  let o2 = parseFloat(document.getElementById("odd2").value);

  if(!o1 || !oX || !o2){
    alert("Ampidiro daholo ny cotes 1, X, 2");
    return;
  }

  let p1 = 1/o1;
  let pX = 1/oX;
  let p2 = 1/o2;

  let total = p1 + pX + p2;

  let prob1 = (p1/total)*100;
  let probX = (pX/total)*100;
  let prob2 = (p2/total)*100;

  document.getElementById("p1").innerText = prob1.toFixed(2)+"%";
  document.getElementById("pX").innerText = probX.toFixed(2)+"%";
  document.getElementById("p2").innerText = prob2.toFixed(2)+"%";

  let margin = (total - 1)*100;
  document.getElementById("margin").innerText = margin.toFixed(2)+"%";

  let max = Math.max(prob1, probX, prob2);

  if(max === prob1){
    document.getElementById("pick").innerText = "1 (Home)";
  }else if(max === probX){
    document.getElementById("pick").innerText = "X (Draw)";
  }else{
    document.getElementById("pick").innerText = "2 (Away)";
  }
}

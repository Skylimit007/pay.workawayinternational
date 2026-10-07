document.addEventListener("DOMContentLoaded", () => {
  const stkForm = document.getElementById("stkForm");
  const submitBtn = document.getElementById("submitBtn");
  const statusAlert = document.getElementById("statusAlert");
  const queryContainer = document.getElementById("queryContainer");
  const queryBtn = document.getElementById("queryBtn");

  let checkoutRequestId = null;

  function showAlert(message, type) {
    statusAlert.innerText = message;
    statusAlert.className = `status-alert ${type}`;
  }

  /*
  |--------------------------------------------------------------------------
  | STK PUSH
  |--------------------------------------------------------------------------
  */

  stkForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const phoneNumber =
      document.getElementById("phoneNumber").value.trim();

    if (!phoneNumber) {
      showAlert(
        "Please enter your M-Pesa phone number.",
        "error"
      );

      return;
    }

    submitBtn.disabled = true;
    submitBtn.innerText = "Sending Prompt...";

    queryContainer.classList.add("hidden");

    checkoutRequestId = null;

    try {
      const response = await fetch(
        "/api/stkpush",
        {
          method: "POST",

          headers: {
            "Content-Type": "application/json"
          },

          body: JSON.stringify({
            phoneNumber
          })
        }
      );

      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(
          result.message ||
          "Unable to initiate payment."
        );
      }

      checkoutRequestId =
        result.checkoutRequestId;

      showAlert(
        result.message ||
        "STK prompt sent. Enter your M-Pesa PIN.",
        "info"
      );

      queryContainer.classList.remove("hidden");

    } catch (error) {
      console.error(
        "[STK PUSH FRONTEND ERROR]",
        error
      );

      showAlert(
        error.message ||
        "Network error sending payment prompt.",
        "error"
      );

    } finally {
      submitBtn.disabled = false;
      submitBtn.innerText = "Pay Now";
    }
  });

  /*
  |--------------------------------------------------------------------------
  | QUERY PAYMENT
  |--------------------------------------------------------------------------
  */

  queryBtn.addEventListener(
    "click",
    async () => {
      if (!checkoutRequestId) {
        showAlert(
          "There is no payment transaction to check.",
          "error"
        );

        return;
      }

      queryBtn.disabled = true;
      queryBtn.innerText = "Checking...";

      try {
        const response = await fetch(
          "/api/stkpush/query",
          {
            method: "POST",

            headers: {
              "Content-Type": "application/json"
            },

            body: JSON.stringify({
              checkoutRequestId
            })
          }
        );

        const result =
          await response.json();

        if (!response.ok) {
          throw new Error(
            result.message ||
            "Unable to check payment status."
          );
        }

        if (result.success) {
          showAlert(
            "Payment Completed Successfully!",
            "success"
          );
        } else {
          showAlert(
            `Status: ${
              result.resultDesc ||
              "Payment is pending or was cancelled."
            }`,
            "error"
          );
        }

      } catch (error) {
        console.error(
          "[PAYMENT QUERY ERROR]",
          error
        );

        showAlert(
          error.message ||
          "Error checking transaction status.",
          "error"
        );

      } finally {
        queryBtn.disabled = false;
        queryBtn.innerText =
          "Check Payment Status";
      }
    }
  );
});
